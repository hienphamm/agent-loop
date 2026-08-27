import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { discoverAgentsMd } from "../agentsMd/discover.js";
import type { AgentLoopConfig } from "../config/schema.js";
import { AgentLoopError } from "../errors/index.js";
import { ApprovalGate } from "../execution/approval.js";
import { Executor } from "../execution/executor.js";
import type { EventBus } from "../events/bus.js";
import { ContextManager } from "../context/manager.js";
import type { Repository } from "../persistence/repository.js";
import type { ProviderAdapter } from "../providers/types.js";
import { TaskDag } from "./dag.js";
import { DeveloperAgent } from "./developer.js";
import { PlannerReviewerAgent } from "./plannerReviewer.js";
import {
  backoffDelay,
  isRetryableError,
  DEFAULT_RETRY_POLICY,
} from "./retry.js";
import type { Run, Task } from "./types.js";

export interface RunLoopOptions {
  runId?: string;
  prompt?: string;
  config: AgentLoopConfig;
  repository: Repository;
  events: EventBus;
  reviewerProvider: ProviderAdapter;
  developerProvider: ProviderAdapter;
  dryRun?: boolean;
  concurrency?: number;
  isCancelled?: () => boolean;
}

/**
 * Drives one run from planning through execution, review, and bounded
 * revision. Safe to call again with the same runId after a crash: it
 * resumes from the persisted task/approval state instead of starting over.
 */
export async function runOrchestration(options: RunLoopOptions): Promise<Run> {
  const { repository, events, config } = options;
  const isCancelled = options.isCancelled ?? (() => false);

  let run = options.runId ? repository.getRun(options.runId) : undefined;
  if (!run) {
    if (!options.prompt)
      throw new Error("prompt is required to start a new run");
    const id = options.runId ?? randomUUID();
    run = repository.createRun(
      {
        id,
        prompt: options.prompt,
        workspace: config.workspace,
        status: "pending",
      },
      JSON.stringify({
        approvalMode: config.approvalMode,
        workspace: config.workspace,
      }),
    );
    events.emit({
      runId: run.id,
      type: "run_started",
      data: { prompt: options.prompt },
    });
  }

  // Every event this run's bus emits is durably persisted here, in the one
  // place that actually drives a run — regardless of which process or API
  // surface (CLI, library caller, test) is calling runOrchestration. This
  // also lets a *different* process (`agent-loop logs`/`status`) see this
  // run's history while it's still in progress.
  const detachPersistence = events.onEvent((event) => {
    repository.appendEvent(event);
  });

  // Refuse to drive the same run from two processes at once: they would
  // otherwise race on task/approval state (double-execute a task, stomp
  // each other's status transitions). A dead holder's lock is reclaimed.
  const holder = `${process.pid}@${process.hrtime.bigint()}`;
  const gotLock = repository.tryAcquireRunLock(run.id, holder, process.pid);
  if (!gotLock) {
    detachPersistence();
    throw new AgentLoopError(
      "RUN_LOCKED",
      `Run ${run.id} is already being driven by another process`,
      {
        hint: "Wait for the other `agent-loop run`/`resume` process to finish, or confirm it's actually dead before retrying.",
      },
    );
  }

  const approvalGate = new ApprovalGate(
    repository,
    events,
    config.approvalMode,
    { isCancelled },
  );
  const executor = new Executor(
    config.workspace,
    run.id,
    repository,
    events,
    approvalGate,
    {
      dryRun: options.dryRun,
    },
  );

  try {
    if (run.status === "pending" || run.status === "planning") {
      await planPhase(run.id, options, executor);
      run = repository.getRun(run.id)!;
    }

    if (run.status === "awaiting_approval") {
      const approved = await approvalGate.requestApproval({
        runId: run.id,
        scope: "plan",
        summary: `execute plan for run ${run.id}`,
      });
      if (!approved) {
        repository.updateRunStatus(run.id, "cancelled");
        events.emit({
          runId: run.id,
          type: "run_cancelled",
          data: { reason: "plan rejected" },
        });
        return repository.getRun(run.id)!;
      }
      repository.updateRunStatus(run.id, "running");
      run = repository.getRun(run.id)!;
    }

    let round = 1;
    while (run.status === "running" || run.status === "reviewing") {
      if (isCancelled()) {
        repository.updateRunStatus(run.id, "cancelled");
        events.emit({ runId: run.id, type: "run_cancelled", data: {} });
        return repository.getRun(run.id)!;
      }

      await executePhase(run.id, options, executor, isCancelled);
      if (isCancelled()) continue;

      const tasks = repository.listTasks(run.id);
      const anyFailed = tasks.some((t) => t.status === "failed");

      repository.updateRunStatus(run.id, "reviewing");
      const reviewDecision = await reviewPhase(run.id, options, tasks, round);

      if (reviewDecision.decision === "approve" && !anyFailed) {
        repository.updateRunStatus(run.id, "completed");
        events.emit({
          runId: run.id,
          type: "run_completed",
          data: { rounds: round },
        });
        break;
      }

      if (
        reviewDecision.decision === "reject" ||
        round >= config.maxReviewRounds
      ) {
        repository.updateRunStatus(run.id, "failed");
        events.emit({
          runId: run.id,
          type: "run_failed",
          data: {
            reason:
              reviewDecision.decision === "reject"
                ? "reviewer rejected"
                : "max review rounds reached",
          },
        });
        break;
      }

      if (reviewDecision.followUpTasks?.length) {
        repository.addFollowUpTasks(run.id, reviewDecision.followUpTasks);
      }
      round += 1;
      repository.updateRunStatus(run.id, "running");
      run = repository.getRun(run.id)!;
    }
  } catch (error) {
    repository.updateRunStatus(run.id, "failed");
    events.emit({
      runId: run.id,
      type: "run_failed",
      data: { error: (error as Error).message },
    });
    throw error;
  } finally {
    repository.releaseRunLock(run.id, holder);
    detachPersistence();
  }

  return repository.getRun(run.id)!;
}

async function planPhase(
  runId: string,
  options: RunLoopOptions,
  executor: Executor,
): Promise<void> {
  const { repository, events, config, reviewerProvider } = options;
  repository.updateRunStatus(runId, "planning");

  const discovery = discoverAgentsMd(config.workspace);
  if (discovery.conflicts.length > 0) {
    events.emit({
      runId,
      type: "progress",
      data: {
        message: `AGENTS.md conflicts detected: ${discovery.conflicts.map((c) => c.key).join(", ")}`,
        conflicts: discovery.conflicts,
      },
    });
  }

  const context = new ContextManager(
    runId,
    "reviewer",
    reviewerProvider,
    repository,
    events,
    config.contextTokenBudget,
    config.reviewer.model,
  );
  repository.setRunConversation(runId, context.currentConversationId);
  const planner = new PlannerReviewerAgent(
    reviewerProvider,
    config.reviewer.model,
    context,
  );

  const run = repository.getRun(runId)!;
  const plan = await planner.plan(run.prompt, discovery.orderedRules);

  // Validate the DAG before persisting so a malformed plan never reaches execution.
  new TaskDag(plan.tasks);

  repository.insertTasks(runId, plan.tasks);
  events.emit({
    runId,
    type: "plan_ready",
    data: { taskCount: plan.tasks.length, rationale: plan.rationale },
  });
  executor.createCheckpoint(undefined, "plan created");

  repository.updateRunStatus(runId, "awaiting_approval");
}

async function executePhase(
  runId: string,
  options: RunLoopOptions,
  executor: Executor,
  isCancelled: () => boolean,
): Promise<void> {
  const { repository, events, config, developerProvider } = options;
  const concurrency = options.concurrency ?? 2;

  const tasks = repository.listTasks(runId);
  const dag = new TaskDag(
    tasks.map((t) => ({
      id: t.id,
      description: t.description,
      dependencies: t.dependencies,
      scope: t.scope,
      risk: t.risk,
      acceptanceCriteria: t.acceptanceCriteria,
    })),
  );

  const completed = new Set(
    tasks
      .filter((t) => t.status === "completed" || t.status === "skipped")
      .map((t) => t.id),
  );
  const inFlightOrDone = new Set(completed);

  while (completed.size < dag.size) {
    if (isCancelled()) return;
    const ready = dag.readyTasks(completed, inFlightOrDone);
    if (ready.length === 0) break; // remaining tasks are blocked on a failed dependency

    const batch = ready.slice(0, concurrency);
    for (const spec of batch) inFlightOrDone.add(spec.id);

    await Promise.all(
      batch.map(async (spec) => {
        // A fresh context/agent per task, not shared across the batch: two
        // tasks in the same batch can run concurrently (up to `concurrency`),
        // and a shared ContextManager would race on its message array and
        // token count across those concurrent `await` points, corrupting
        // ordering and potentially leaking one task's payload into another
        // task's provider call. Isolation costs a little continuity between
        // sibling tasks; correctness under concurrency requires it.
        const context = new ContextManager(
          runId,
          "developer",
          developerProvider,
          repository,
          events,
          config.contextTokenBudget,
          config.developer.model,
        );
        const developer = new DeveloperAgent(
          developerProvider,
          config.developer.model,
          context,
          executor,
        );

        const ok = await runTaskWithRetry(runId, spec.id, options, developer);
        if (ok) completed.add(spec.id);
        executor.createCheckpoint(
          spec.id,
          `task ${spec.id} ${ok ? "completed" : "failed"}`,
        );
      }),
    );
  }
}

async function runTaskWithRetry(
  runId: string,
  taskId: string,
  options: RunLoopOptions,
  developer: DeveloperAgent,
): Promise<boolean> {
  const { repository, events } = options;
  const task = repository.getTask(runId, taskId);
  if (!task) return false;
  if (task.status === "completed") return true;

  repository.updateTaskStatus(runId, taskId, "running");
  events.emit({
    runId,
    taskId,
    type: "task_started",
    data: { description: task.description },
  });

  let attempt = task.retryCount + 1;
  for (;;) {
    try {
      const results = await developer.run(task);
      repository.setTaskResult(runId, taskId, results);
      repository.updateTaskStatus(runId, taskId, "completed");
      events.emit({ runId, taskId, type: "task_completed", data: {} });
      return true;
    } catch (error) {
      const message = (error as Error).message;
      if (
        !isRetryableError(error) ||
        attempt >= DEFAULT_RETRY_POLICY.maxAttempts
      ) {
        repository.updateTaskStatus(runId, taskId, "failed", message);
        events.emit({
          runId,
          taskId,
          type: "task_failed",
          data: { error: message, attempt },
        });
        return false;
      }
      const delay = backoffDelay(attempt);
      repository.recordRetry({
        runId,
        taskId,
        attempt,
        error: message,
        backoffMs: delay,
      });
      repository.incrementRetry(runId, taskId);
      events.emit({
        runId,
        taskId,
        type: "progress",
        data: {
          message: `retrying after error: ${message} (attempt ${attempt}, waiting ${delay}ms)`,
        },
      });
      await sleep(delay);
      attempt += 1;
    }
  }
}

async function reviewPhase(
  runId: string,
  options: RunLoopOptions,
  tasks: Task[],
  round: number,
) {
  const { repository, events, config, reviewerProvider } = options;
  const context = new ContextManager(
    runId,
    "reviewer",
    reviewerProvider,
    repository,
    events,
    config.contextTokenBudget,
    config.reviewer.model,
  );
  const reviewer = new PlannerReviewerAgent(
    reviewerProvider,
    config.reviewer.model,
    context,
  );
  const result = await reviewer.review(tasks, round, config.maxReviewRounds);
  events.emit({
    runId,
    type: "review_result",
    data: { decision: result.decision, notes: result.notes, round },
  });
  return result;
}

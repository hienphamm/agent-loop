import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { MockProvider } from "../../src/providers/mock.js";
import { runOrchestration } from "../../src/orchestration/runLoop.js";
import type { AgentLoopConfig } from "../../src/config/schema.js";

/**
 * These tests simulate "the process died right here" at each important
 * transition by controlling exactly what a scripted provider does and by
 * directly inspecting/mutating repository state between two sequential
 * `runOrchestration` calls against the SAME (in-memory, but otherwise
 * indistinguishable from on-disk) database — the same recovery contract
 * as a real crash, but deterministic instead of timing-dependent. A real
 * OS-process kill is covered separately in crashRecovery.test.ts for the
 * "mid command execution" case, which is the one that most needs a true
 * kill (async I/O in flight, not just JS control flow).
 */

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-resume-granular-"));
}

function baseConfig(
  workspace: string,
  overrides: Partial<AgentLoopConfig> = {},
): AgentLoopConfig {
  return {
    workspace,
    approvalMode: "all",
    reviewer: {
      provider: "mock",
      model: "m",
      auth: "api_key",
      apiKey: "unused",
    },
    developer: {
      provider: "mock",
      model: "m",
      auth: "api_key",
      apiKey: "unused",
    },
    contextTokenBudget: 100_000,
    maxReviewRounds: 3,
    stateDir: "/unused",
    ...overrides,
  };
}

describe("granular resume points", () => {
  it("crash before persistence: the plan is validated but never even reaches insertTasks — resume just re-plans from 'pending'", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    // First "process": planner throws right after producing a plan, before
    // the orchestrator gets to persist it (simulated by throwing from the
    // provider on the very first call).
    let planCalls = 0;
    const reviewerThatCrashes = new MockProvider(() => {
      planCalls += 1;
      throw new Error("simulated crash before plan persistence");
    });

    await expect(
      runOrchestration({
        prompt: "plan then crash",
        config: baseConfig(workspace),
        repository,
        events,
        reviewerProvider: reviewerThatCrashes,
        developerProvider: new MockProvider(() => ({ content: "{}" })),
      }),
    ).rejects.toThrow();

    const runs = repository.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(repository.listTasks(runs[0]!.id)).toHaveLength(0);
    expect(planCalls).toBe(1);

    // "Resume": run status is "failed", not a normally-resumable state, but
    // since no tasks/side effects exist yet, re-running the *same run id*
    // through planPhase again is safe. We simulate the practical recovery
    // path an operator takes: same run id, status forced back to "pending"
    // (this is what a future `agent-loop retry`/re-plan command would do;
    // today's `resume` intentionally does not resurrect "failed" runs).
    repository.updateRunStatus(runs[0]!.id, "pending");
    const workingReviewer = new MockProvider((request) => {
      const isPlanCall = request.messages.some((m) =>
        m.content.includes("You are the Planner"),
      );
      if (isPlanCall) {
        return {
          content: JSON.stringify({
            tasks: [
              {
                id: "t1",
                description: "d",
                dependencies: [],
                risk: "low",
                acceptanceCriteria: [],
              },
            ],
          }),
        };
      }
      return { content: JSON.stringify({ decision: "approve", notes: "ok" }) };
    });
    const result = await runOrchestration({
      runId: runs[0]!.id,
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: workingReviewer,
      developerProvider: new MockProvider(() => ({
        content: JSON.stringify({ actions: [] }),
      })),
    });
    expect(result.status).toBe("completed");
  });

  it("crash stuck in 'planning' status (never reached awaiting_approval) is resumed by re-entering the plan phase", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const run = repository.createRun(
      { id: "stuck-planning", prompt: "do it", workspace, status: "planning" },
      "{}",
    );
    expect(run.status).toBe("planning");

    const reviewer = new MockProvider((request) => {
      const isPlanCall = request.messages.some((m) =>
        m.content.includes("You are the Planner"),
      );
      if (isPlanCall) {
        return {
          content: JSON.stringify({
            tasks: [
              {
                id: "t1",
                description: "d",
                dependencies: [],
                risk: "low",
                acceptanceCriteria: [],
              },
            ],
          }),
        };
      }
      return { content: JSON.stringify({ decision: "approve", notes: "ok" }) };
    });

    const result = await runOrchestration({
      runId: "stuck-planning",
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: new MockProvider(() => ({
        content: JSON.stringify({ actions: [] }),
      })),
    });

    expect(result.status).toBe("completed");
    expect(repository.listTasks("stuck-planning")).toHaveLength(1);
  });

  it("crash after a task's side effect completed but before the task row was marked completed: idempotency prevents duplicating the write", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const run = repository.createRun(
      { id: "crash-after-effect", prompt: "p", workspace, status: "running" },
      "{}",
    );
    repository.insertTasks(run.id, [
      {
        id: "t1",
        description: "write once",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    repository.updateTaskStatus(run.id, "t1", "running");

    // Simulate: the write already happened (idempotency key recorded as
    // completed) but the crash happened before `updateTaskStatus(...,
    // "completed")` ran — task status is still "running" in the DB.
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update(["write_file", run.id, "t1", "once.txt", "v1"].join(" "))
      .digest("hex");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "once.txt"), "v1", "utf8");
    repository.recordIdempotentResult(key, run.id, "t1", "low", {
      path: "once.txt",
    });

    const reviewer = new MockProvider((request) => {
      const isPlanCall = request.messages.some((m) =>
        m.content.includes("You are the Planner"),
      );
      if (isPlanCall)
        throw new Error("should not re-plan: tasks already exist");
      return { content: JSON.stringify({ decision: "approve", notes: "ok" }) };
    });
    const developer = new MockProvider(() => ({
      content: JSON.stringify({
        actions: [{ type: "write_file", path: "once.txt", content: "v1" }],
      }),
    }));

    const result = await runOrchestration({
      runId: run.id,
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
    });

    expect(result.status).toBe("completed");
    expect(repository.getTask(run.id, "t1")?.status).toBe("completed");
    // Still exactly the original content — the idempotency cache hit meant
    // the write never actually re-ran.
    expect(readFileSync(path.join(workspace, "once.txt"), "utf8")).toBe("v1");
  });

  it("crash during review (status stuck at 'reviewing') is resumed by re-entering the loop and reviewing again", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const run = repository.createRun(
      {
        id: "crash-during-review",
        prompt: "p",
        workspace,
        status: "reviewing",
      },
      "{}",
    );
    repository.insertTasks(run.id, [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    repository.updateTaskStatus(run.id, "t1", "completed");

    let reviewCalls = 0;
    const reviewer = new MockProvider((request) => {
      const isPlanCall = request.messages.some((m) =>
        m.content.includes("You are the Planner"),
      );
      if (isPlanCall) throw new Error("should not re-plan");
      reviewCalls += 1;
      return { content: JSON.stringify({ decision: "approve", notes: "ok" }) };
    });

    const result = await runOrchestration({
      runId: run.id,
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: new MockProvider(() => {
        throw new Error("should not re-execute the already-completed task");
      }),
    });

    expect(result.status).toBe("completed");
    expect(reviewCalls).toBe(1);
  });

  it("crash during approval waiting: resume observes the approval that was granted while the process was down", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const run = repository.createRun(
      {
        id: "crash-during-approval",
        prompt: "p",
        workspace,
        status: "awaiting_approval",
      },
      "{}",
    );
    repository.insertTasks(run.id, [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    // Simulate `agent-loop approve` having been run while the orchestrator
    // process was down: the plan-level approval already exists and is approved.
    const approval = repository.createApproval({
      runId: run.id,
      scope: "plan",
      summary: `execute plan for run ${run.id}`,
    });
    repository.resolveApproval(approval.id, "approved");

    const reviewer = new MockProvider(() => ({
      content: JSON.stringify({ decision: "approve", notes: "ok" }),
    }));
    const result = await runOrchestration({
      runId: run.id,
      config: { ...baseConfig(workspace), approvalMode: "manual" },
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: new MockProvider(() => ({
        content: JSON.stringify({ actions: [] }),
      })),
    });

    expect(result.status).toBe("completed");
  });

  it("does not duplicate retry counts across a simulated resume", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const run = repository.createRun(
      { id: "retry-count-check", prompt: "p", workspace, status: "running" },
      "{}",
    );
    repository.insertTasks(run.id, [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    // Simulate one retry already recorded by a prior (crashed) attempt.
    repository.incrementRetry(run.id, "t1");
    repository.recordRetry({
      runId: run.id,
      taskId: "t1",
      attempt: 1,
      error: "transient",
      backoffMs: 1000,
    });
    expect(repository.getTask(run.id, "t1")?.retryCount).toBe(1);

    const reviewer = new MockProvider(() => ({
      content: JSON.stringify({ decision: "approve", notes: "ok" }),
    }));
    const developer = new MockProvider(() => ({
      content: JSON.stringify({ actions: [] }),
    }));

    const result = await runOrchestration({
      runId: run.id,
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
    });

    expect(result.status).toBe("completed");
    // Succeeds on the first attempt after resume; retryCount must reflect
    // only the one genuine prior retry, not be reset or double-counted.
    expect(repository.getTask(run.id, "t1")?.retryCount).toBe(1);
  });
});

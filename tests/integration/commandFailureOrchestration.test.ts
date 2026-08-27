import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { MockProvider } from "../../src/providers/mock.js";
import { runOrchestration } from "../../src/orchestration/runLoop.js";
import type { AgentLoopConfig } from "../../src/config/schema.js";
import type { BaseEvent } from "../../src/events/types.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-cmd-failure-"));
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
    maxReviewRounds: 1,
    stateDir: "/unused",
    ...overrides,
  };
}

function reviewerPlanning(tasks: unknown[]) {
  return new MockProvider((request) => {
    const isPlanCall = request.messages.some((m) =>
      m.content.includes("You are the Planner"),
    );
    if (isPlanCall) return { content: JSON.stringify({ tasks }) };
    return { content: JSON.stringify({ decision: "approve", notes: "ok" }) };
  });
}

const singleTask = [
  {
    id: "only",
    description: "only task",
    dependencies: [],
    risk: "low",
    acceptanceCriteria: [],
  },
];

describe("run_command exit-code failures through the full orchestration loop", () => {
  it("never marks the task/run completed when a command exits with an unexpected code, and retries it", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();
    let developerCalls = 0;
    const developer = new MockProvider(() => {
      developerCalls += 1;
      return {
        content: JSON.stringify({
          actions: [{ type: "run_command", command: "exit 1" }],
        }),
      };
    });

    const run = await runOrchestration({
      prompt: "unexpected exit",
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewerPlanning(singleTask),
      developerProvider: developer,
      concurrency: 1,
    });

    // Retry policy (3 attempts) was actually invoked, not just the first try.
    expect(developerCalls).toBe(3);

    const task = repository.getTask(run.id, "only");
    expect(task?.status).toBe("failed");
    expect(run.status).not.toBe("completed");
    expect(run.status).toBe("failed");
  }, 20_000);

  it("succeeds and completes normally when expectedExitCodes explicitly accepts the exit code", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();
    const developer = new MockProvider(() => ({
      content: JSON.stringify({
        actions: [
          {
            type: "run_command",
            command: "exit 1",
            expectedExitCodes: [0, 1],
          },
        ],
      }),
    }));

    const run = await runOrchestration({
      prompt: "accepted non-zero exit",
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewerPlanning(singleTask),
      developerProvider: developer,
      concurrency: 1,
    });

    expect(repository.getTask(run.id, "only")?.status).toBe("completed");
    expect(run.status).toBe("completed");
  });

  it("exposes a stable, machine-readable failure reason in task_failed/progress event evidence", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();
    const seen: BaseEvent[] = [];
    events.onEvent((e) => {
      if (e.type === "task_failed" || e.type === "progress") seen.push(e);
    });
    const developer = new MockProvider(() => ({
      content: JSON.stringify({
        actions: [{ type: "run_command", command: "exit 7" }],
      }),
    }));

    await runOrchestration({
      prompt: "structured evidence",
      config: baseConfig(workspace, { maxReviewRounds: 1 }),
      repository,
      events,
      reviewerProvider: reviewerPlanning(singleTask),
      developerProvider: developer,
      concurrency: 1,
    });

    const taskFailed = seen.find((e) => e.type === "task_failed");
    expect(taskFailed).toBeDefined();
    expect(taskFailed!.data.code).toBe("UNEXPECTED_EXIT_CODE");
    expect(taskFailed!.data.reason).toBe("UNEXPECTED_EXIT_CODE");
    expect(taskFailed!.data.actualExitCode).toBe(7);
    expect(taskFailed!.data.expectedExitCodes).toEqual([0]);

    // A retry attempt's progress event also carries the same structured
    // evidence, not just a free-text message.
    const retryProgress = seen.find(
      (e) =>
        e.type === "progress" &&
        typeof e.data.message === "string" &&
        e.data.message.includes("retrying after error"),
    );
    expect(retryProgress).toBeDefined();
    expect(retryProgress!.data.code).toBe("UNEXPECTED_EXIT_CODE");
  }, 20_000);

  it("persists the final failure after retries are exhausted (does not silently drop it)", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();
    const developer = new MockProvider(() => ({
      content: JSON.stringify({
        actions: [{ type: "run_command", command: "exit 3" }],
      }),
    }));

    const run = await runOrchestration({
      prompt: "persisted final failure",
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewerPlanning(singleTask),
      developerProvider: developer,
      concurrency: 1,
    });

    const task = repository.getTask(run.id, "only");
    expect(task?.status).toBe("failed");
    expect(task?.error).toBeTruthy();
    // The persisted error text does not depend on an opaque JS message
    // alone: the stable reason is embedded and greppable.
    expect(task?.error).toContain("exited with code 3");

    // Re-fetching tasks (as `agent-loop status`/reviewer evidence would)
    // still reflects "failed", never "completed".
    const tasksAgain = repository.listTasks(run.id);
    expect(tasksAgain.find((t) => t.id === "only")?.status).toBe("failed");
  }, 20_000);

  it("invalid expectedExitCodes fails deterministically without ever running the command", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();
    let commandStarted = false;
    events.onType("command_started", () => {
      commandStarted = true;
    });
    const developer = new MockProvider(() => ({
      content: JSON.stringify({
        actions: [
          { type: "run_command", command: "exit 0", expectedExitCodes: [] },
        ],
      }),
    }));

    const run = await runOrchestration({
      prompt: "invalid expectedExitCodes",
      config: baseConfig(workspace, { maxReviewRounds: 1 }),
      repository,
      events,
      reviewerProvider: reviewerPlanning(singleTask),
      developerProvider: developer,
      concurrency: 1,
    });

    expect(commandStarted).toBe(false);
    expect(repository.getTask(run.id, "only")?.status).toBe("failed");
    // Not retried repeatedly (INVALID_ACTION is non-retryable): only 1 attempt.
    expect(repository.getTask(run.id, "only")?.retryCount).toBe(0);
  });
});

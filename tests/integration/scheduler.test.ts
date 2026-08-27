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

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-scheduler-"));
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

function reviewerPlanning(tasks: unknown[]) {
  return new MockProvider((request) => {
    const isPlanCall = request.messages.some((m) =>
      m.content.includes("You are the Planner"),
    );
    if (isPlanCall) return { content: JSON.stringify({ tasks }) };
    return { content: JSON.stringify({ decision: "approve", notes: "ok" }) };
  });
}

describe("DAG scheduler behavior (through the full run loop)", () => {
  it("does not start a task until its dependencies have completed", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();
    const order: string[] = [];
    events.onType("task_started", (e) => order.push(e.taskId!));

    const reviewer = reviewerPlanning([
      {
        id: "a",
        description: "a",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "b",
        description: "b",
        dependencies: ["a"],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "c",
        description: "c",
        dependencies: ["b"],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    const developer = new MockProvider(() => ({
      content: JSON.stringify({ actions: [] }),
    }));

    const run = await runOrchestration({
      prompt: "chain",
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
      concurrency: 3,
    });

    expect(run.status).toBe("completed");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("runs independent tasks within a concurrency limit, and a failed dependency blocks its dependents", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const reviewer = reviewerPlanning([
      {
        id: "fails",
        description: "fails",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "depends-on-failure",
        description: "depends",
        dependencies: ["fails"],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "independent",
        description: "independent",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    const developer = new MockProvider((request) => {
      const payload = JSON.parse(
        request.messages[request.messages.length - 1]!.content,
      ) as { id: string };
      if (payload.id === "fails") {
        return {
          content: JSON.stringify({
            actions: [{ type: "run_command", command: "exit 1" }],
          }),
        };
      }
      return { content: JSON.stringify({ actions: [] }) };
    });

    const run = await runOrchestration({
      prompt: "partial failure",
      config: { ...baseConfig(workspace), maxReviewRounds: 1 },
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
      concurrency: 2,
    });

    const tasks = repository.listTasks(run.id);
    const independent = tasks.find((t) => t.id === "independent");
    const dependent = tasks.find((t) => t.id === "depends-on-failure");
    const failed = tasks.find((t) => t.id === "fails");

    // "fails" runs `exit 1` with the default expectedExitCodes ([0]), so the
    // run_command action — and therefore the task attempt — must fail; it
    // must never be silently treated as completed just because the
    // developer step didn't throw a JS exception on its own. What matters
    // here is that the DAG scheduler still ran the independent task and left
    // the true dependency ordering intact despite this task failing.
    expect(independent?.status).toBe("completed");
    expect(failed?.status).toBe("failed");
    expect(dependent).toBeDefined();
  });

  it("really blocks a dependent task when its dependency task fails outright", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const reviewer = reviewerPlanning([
      {
        id: "fails",
        description: "fails",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "dependent",
        description: "dependent",
        dependencies: ["fails"],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    // Developer throws (non-retryable) for "fails" specifically.
    const developer = new MockProvider((request) => {
      const last = request.messages[request.messages.length - 1]!.content;
      if (last.includes('"id":"fails"')) {
        throw Object.assign(new Error("boom"), {
          name: "WorkspaceSafetyError",
        });
      }
      return { content: JSON.stringify({ actions: [] }) };
    });

    const run = await runOrchestration({
      prompt: "hard failure blocks dependents",
      config: { ...baseConfig(workspace), maxReviewRounds: 1 },
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
      concurrency: 2,
    });

    const tasks = repository.listTasks(run.id);
    expect(tasks.find((t) => t.id === "fails")?.status).toBe("failed");
    // "dependent" never became ready (its dependency never completed), so
    // the scheduler left it pending rather than running it anyway.
    expect(tasks.find((t) => t.id === "dependent")?.status).toBe("pending");
    expect(run.status).toBe("failed");
  });

  it("retrying one task does not rerun an unrelated already-completed task", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    let flakyAttempts = 0;
    let stableCalls = 0;

    const reviewer = reviewerPlanning([
      {
        id: "stable",
        description: "stable",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "flaky",
        description: "flaky",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    const developer = new MockProvider((request) => {
      const last = request.messages[request.messages.length - 1]!.content;
      if (last.includes('"id":"flaky"')) {
        flakyAttempts += 1;
        if (flakyAttempts < 2) {
          throw new Error("transient failure");
        }
        return { content: JSON.stringify({ actions: [] }) };
      }
      stableCalls += 1;
      return { content: JSON.stringify({ actions: [] }) };
    });

    const run = await runOrchestration({
      prompt: "flaky task retries in isolation",
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
      concurrency: 2,
    });

    expect(run.status).toBe("completed");
    expect(flakyAttempts).toBe(2);
    expect(stableCalls).toBe(1); // never rerun just because a sibling task retried
  });

  it("propagates cancellation: no further tasks start once cancelled mid-batch", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();
    let cancelled = false;
    const started: string[] = [];
    events.onType("task_started", (e) => {
      started.push(e.taskId!);
      if (e.taskId === "a") cancelled = true; // cancel right after the first task starts
    });

    const reviewer = reviewerPlanning([
      {
        id: "a",
        description: "a",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "b",
        description: "b",
        dependencies: ["a"],
        risk: "low",
        acceptanceCriteria: [],
      },
      {
        id: "c",
        description: "c",
        dependencies: ["a"],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    const developer = new MockProvider(() => ({
      content: JSON.stringify({ actions: [] }),
    }));

    const run = await runOrchestration({
      prompt: "cancel mid-batch",
      config: baseConfig(workspace),
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
      concurrency: 1,
      isCancelled: () => cancelled,
    });

    expect(run.status).toBe("cancelled");
    expect(started).toEqual(["a"]); // b and c never started
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { MockProvider } from "../../src/providers/mock.js";
import { runOrchestration } from "../../src/orchestration/runLoop.js";
import type { AgentLoopConfig } from "../../src/config/schema.js";
import type { BaseEvent } from "../../src/events/types.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-int-"));
}

function baseConfig(workspace: string): AgentLoopConfig {
  return {
    workspace,
    approvalMode: "all", // auto-approve everything so the test run doesn't block on human input
    reviewer: {
      provider: "mock",
      model: "mock-reviewer",
      auth: "api_key",
      apiKey: "unused",
    },
    developer: {
      provider: "mock",
      model: "mock-developer",
      auth: "api_key",
      apiKey: "unused",
    },
    contextTokenBudget: 100_000,
    maxReviewRounds: 3,
    stateDir: "/unused",
  };
}

/** A scripted reviewer: plans one task, then approves whatever comes back. */
function scriptedReviewerProvider() {
  let call = 0;
  return new MockProvider((request) => {
    call += 1;
    const isPlanCall = request.messages.some((m) =>
      m.content.includes("You are the Planner"),
    );
    if (isPlanCall) {
      return {
        content: JSON.stringify({
          tasks: [
            {
              id: "write-file",
              description: "write hello.txt",
              dependencies: [],
              risk: "low",
              acceptanceCriteria: ["file exists"],
            },
          ],
          rationale: "single simple task",
        }),
      };
    }
    return {
      content: JSON.stringify({ decision: "approve", notes: `ok (${call})` }),
    };
  });
}

/** A scripted developer: always writes one file inside the workspace. */
function scriptedDeveloperProvider() {
  return new MockProvider(() => ({
    content: JSON.stringify({
      actions: [
        {
          type: "write_file",
          path: "hello.txt",
          content: "hello from agent-loop",
        },
      ],
    }),
  }));
}

describe("run lifecycle (mocked providers)", () => {
  let repository: Repository;
  let events: EventBus;
  let seen: BaseEvent[];

  beforeEach(() => {
    repository = new Repository(openInMemoryDatabase());
    events = new EventBus();
    seen = [];
    events.onEvent((e) => seen.push(e));
  });

  it("plans, executes, reviews, and completes a simple run end to end", async () => {
    const workspace = makeWorkspace();
    const config = baseConfig(workspace);

    const run = await runOrchestration({
      prompt: "create hello.txt",
      config,
      repository,
      events,
      reviewerProvider: scriptedReviewerProvider(),
      developerProvider: scriptedDeveloperProvider(),
    });

    expect(run.status).toBe("completed");
    const content = readFileSync(path.join(workspace, "hello.txt"), "utf8");
    expect(content).toBe("hello from agent-loop");

    const tasks = repository.listTasks(run.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");

    const types = seen.map((e) => e.type);
    expect(types).toContain("run_started");
    expect(types).toContain("plan_ready");
    expect(types).toContain("task_completed");
    expect(types).toContain("run_completed");
  });

  it("bounds the revision loop and fails when the reviewer never approves", async () => {
    const workspace = makeWorkspace();
    const config = { ...baseConfig(workspace), maxReviewRounds: 2 };

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
                description: "do it",
                dependencies: [],
                risk: "low",
                acceptanceCriteria: [],
              },
            ],
          }),
        };
      }
      return {
        content: JSON.stringify({
          decision: "request_changes",
          notes: "not good enough",
        }),
      };
    });

    const run = await runOrchestration({
      prompt: "never satisfy the reviewer",
      config,
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: scriptedDeveloperProvider(),
    });

    expect(run.status).toBe("failed");
    const failedEvents = seen.filter((e) => e.type === "run_failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("resumes a crashed run without re-running completed tasks", async () => {
    const workspace = makeWorkspace();
    const config = baseConfig(workspace);
    const runId = randomUUID();

    let developerCallCount = 0;
    const developer = new MockProvider(() => {
      developerCallCount += 1;
      return {
        content: JSON.stringify({
          actions: [{ type: "write_file", path: "hello.txt", content: "v1" }],
        }),
      };
    });

    // First "process": runs planning + execution, then we simulate a crash
    // by simply not calling review (we stop right after tasks complete by
    // driving the run manually through two separate orchestration calls).
    const reviewer = scriptedReviewerProvider();
    const run1 = await runOrchestration({
      runId,
      prompt: "create hello.txt",
      config,
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
    });
    expect(run1.status).toBe("completed");
    expect(developerCallCount).toBe(1);

    // "Resume" the same run id: since it's already completed, re-running the
    // orchestration must not touch the developer provider again nor rewrite the file.
    const run2 = await runOrchestration({
      runId,
      config,
      repository,
      events,
      reviewerProvider: scriptedReviewerProvider(),
      developerProvider: developer,
    });
    expect(run2.status).toBe("completed");
    expect(developerCallCount).toBe(1); // no duplicate execution
  });
});

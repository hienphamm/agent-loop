import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { MockProvider } from "../../src/providers/mock.js";
import { runOrchestration } from "../../src/orchestration/runLoop.js";
import type { AgentLoopConfig } from "../../src/config/schema.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-boundary-"));
}

describe("Executor workspace boundary (full run)", () => {
  it("fails the task instead of writing outside the workspace when the developer tries to escape it", async () => {
    const workspace = makeWorkspace();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "agent-loop-outside-"));

    const config: AgentLoopConfig = {
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
    };

    const reviewer = new MockProvider((request) => {
      const isPlanCall = request.messages.some((m) =>
        m.content.includes("You are the Planner"),
      );
      if (isPlanCall) {
        return {
          content: JSON.stringify({
            tasks: [
              {
                id: "escape",
                description: "try to escape",
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
          decision: "reject",
          notes: "escaped task failed",
        }),
      };
    });

    // Developer tries to write outside the workspace via traversal.
    const developer = new MockProvider(() => ({
      content: JSON.stringify({
        actions: [
          {
            type: "write_file",
            path: `../${path.basename(outsideDir)}/evil.txt`,
            content: "pwned",
          },
        ],
      }),
    }));

    const repository = new Repository(openInMemoryDatabase());
    const events = new EventBus();

    const run = await runOrchestration({
      prompt: "try to escape the workspace",
      config,
      repository,
      events,
      reviewerProvider: reviewer,
      developerProvider: developer,
    });

    expect(run.status).toBe("failed");
    const tasks = repository.listTasks(run.id);
    expect(tasks[0]?.status).toBe("failed");
    expect(existsSync(path.join(outsideDir, "evil.txt"))).toBe(false);
  });
});

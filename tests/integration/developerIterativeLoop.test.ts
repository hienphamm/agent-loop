import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { ApprovalGate } from "../../src/execution/approval.js";
import { Executor } from "../../src/execution/executor.js";
import { ContextManager } from "../../src/context/manager.js";
import { MockProvider } from "../../src/providers/mock.js";
import type {
  CompletionRequest,
  CompletionResult,
} from "../../src/providers/types.js";
import { DeveloperAgent } from "../../src/orchestration/developer.js";
import {
  ActionValidationError,
  WorkspaceSafetyError,
} from "../../src/errors/index.js";
import type { Task } from "../../src/orchestration/types.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-dev-loop-"));
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    runId: "run-1",
    description: "do the thing",
    dependencies: [],
    risk: "low",
    acceptanceCriteria: [],
    status: "running",
    retryCount: 0,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

function makeHarness(workspace: string) {
  const repository = new Repository(openInMemoryDatabase());
  repository.createRun(
    { id: "run-1", prompt: "p", workspace, status: "running" },
    "{}",
  );
  const events = new EventBus();
  const approvalGate = new ApprovalGate(repository, events, "all");
  const executor = new Executor(
    workspace,
    "run-1",
    repository,
    events,
    approvalGate,
  );
  return { repository, events, executor };
}

function makeContext(
  repository: Repository,
  events: EventBus,
  provider: MockProvider,
): ContextManager {
  return new ContextManager(
    "run-1",
    "developer",
    provider,
    repository,
    events,
    100_000,
    "m",
  );
}

/** Scripts a sequence of responses (or a function computing one) per call. */
function scriptedProvider(
  script: Array<
    CompletionResult | ((request: CompletionRequest) => CompletionResult)
  >,
  onCall?: (request: CompletionRequest, index: number) => void,
): MockProvider {
  let calls = 0;
  return new MockProvider((request) => {
    const index = calls;
    calls += 1;
    onCall?.(request, index);
    const entry = script[index];
    if (!entry)
      throw new Error(`scriptedProvider: no response for call #${index}`);
    return typeof entry === "function" ? entry(request) : entry;
  });
}

const DONE_ALL_EMPTY = {
  changedFiles: [] as string[],
  requestedChecks: [] as string[],
  skippedChecks: [] as string[],
  blockers: [] as string[],
  assumptions: [] as string[],
  architecturalDecisions: [] as string[],
};

describe("DeveloperAgent iterative tool loop", () => {
  it("performs read_file -> list_files -> search_text -> run_command -> write_file -> done across separate turns, feeding each sanitized result back into the same conversation", async () => {
    const workspace = makeWorkspace();
    writeFileSync(path.join(workspace, "hello.txt"), "hello world");
    const { repository, events, executor } = makeHarness(workspace);

    const requestsSeen: CompletionRequest[] = [];
    const provider = scriptedProvider(
      [
        {
          content: JSON.stringify({
            action: { type: "read_file", path: "hello.txt" },
          }),
        },
        {
          content: JSON.stringify({
            action: { type: "list_files", path: "." },
          }),
        },
        {
          content: JSON.stringify({
            action: { type: "search_text", query: "hello" },
          }),
        },
        {
          content: JSON.stringify({
            action: { type: "run_command", command: "echo done" },
          }),
        },
        {
          content: JSON.stringify({
            action: { type: "write_file", path: "out.txt", content: "result" },
          }),
        },
        {
          content: JSON.stringify({
            action: {
              type: "done",
              ...DONE_ALL_EMPTY,
              changedFiles: ["out.txt"],
            },
          }),
        },
      ],
      (request) => requestsSeen.push(request),
    );

    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    const result = await developer.run(makeTask());

    expect(result.outcome).toEqual({
      status: "done",
      ...DONE_ALL_EMPTY,
      changedFiles: ["out.txt"],
    });
    expect(result.actionResults).toHaveLength(5);
    expect(existsSync(path.join(workspace, "out.txt"))).toBe(true);
    expect(readFileSync(path.join(workspace, "out.txt"), "utf8")).toBe(
      "result",
    );

    // Each turn after the first action must have received that action's
    // sanitized result back in the conversation before choosing the next one.
    const secondTurnMessages = requestsSeen[1]!.messages;
    const lastMessage = secondTurnMessages[secondTurnMessages.length - 1]!;
    expect(lastMessage.role).toBe("user");
    const parsed = JSON.parse(lastMessage.content);
    expect(parsed.actionResult.content).toBe("hello world");

    const fourthTurnMessages = requestsSeen[3]!.messages;
    const searchResultMessage = JSON.parse(
      fourthTurnMessages[fourthTurnMessages.length - 1]!.content,
    );
    expect(searchResultMessage.actionResult.matches[0].path).toBe("hello.txt");
  });

  it("persists each action request before execution and result before the next turn", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: { type: "write_file", path: "a.txt", content: "1" },
        }),
      },
      {
        content: JSON.stringify({
          action: { type: "read_file", path: "a.txt" },
        }),
      },
      {
        content: JSON.stringify({
          action: { type: "done", ...DONE_ALL_EMPTY, changedFiles: ["a.txt"] },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    await developer.run(makeTask());

    const records = repository.listDeveloperActions("run-1", "t1");
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.seq)).toEqual([1, 2]);
    expect(records.every((r) => r.status === "completed")).toBe(true);
    expect((records[0]!.action as { type: string }).type === "write_file").toBe(
      true,
    );
    expect((records[1]!.result as { content: string }).content).toBe("1");
  });

  it("legacy one-shot actions[] responses remain fully supported", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          actions: [{ type: "write_file", path: "legacy.txt", content: "v1" }],
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    const result = await developer.run(makeTask());

    expect(result.outcome.status).toBe("done");
    if (result.outcome.status === "done") {
      expect(result.outcome.changedFiles).toEqual(["legacy.txt"]);
    }
    expect(existsSync(path.join(workspace, "legacy.txt"))).toBe(true);
  });

  it("an empty legacy actions[] response still completes the task (matches pre-P2 behavior)", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      { content: JSON.stringify({ actions: [] }) },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    const result = await developer.run(makeTask());
    expect(result.outcome).toEqual({ status: "done", ...DONE_ALL_EMPTY });
  });

  it("rejects an unknown action type before any side effect", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: { type: "delete_everything", path: "x" },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    await expect(developer.run(makeTask())).rejects.toThrow(
      ActionValidationError,
    );
    expect(existsSync(path.join(workspace, "x"))).toBe(false);
  });

  it("rejects an unknown field on an otherwise-valid action before any side effect", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: {
            type: "write_file",
            path: "x.txt",
            content: "y",
            extra: "nope",
          },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    let caught: unknown;
    try {
      await developer.run(makeTask());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActionValidationError);
    expect((caught as ActionValidationError).validationCode).toBe(
      "UNKNOWN_FIELD",
    );
    expect(existsSync(path.join(workspace, "x.txt"))).toBe(false);
  });

  it("rejects a malformed run_command action (bad expectedExitCodes) before the command spawns", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: {
            type: "run_command",
            command: "touch spawned.txt",
            expectedExitCodes: [],
          },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    await expect(developer.run(makeTask())).rejects.toThrow(
      ActionValidationError,
    );
    expect(existsSync(path.join(workspace, "spawned.txt"))).toBe(false);
  });

  it("rejects DONE with missing required metadata fields", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: { type: "done", changedFiles: ["a"] },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    await expect(developer.run(makeTask())).rejects.toThrow(
      ActionValidationError,
    );
  });

  it("BLOCKED terminates the loop cleanly with a machine-readable reason and detail, running no further actions", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: {
            type: "blocked",
            reason: "MISSING_INFORMATION",
            detail: "need the target file name",
          },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    const result = await developer.run(makeTask());
    expect(result.outcome).toEqual({
      status: "blocked",
      reason: "MISSING_INFORMATION",
      detail: "need the target file name",
    });
    expect(result.actionResults).toHaveLength(0);
  });

  it("rejects a path-traversal read_file before any Executor evidence is produced, and records the failure durably", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: { type: "read_file", path: "../../etc/passwd" },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    await expect(developer.run(makeTask())).rejects.toThrow(
      WorkspaceSafetyError,
    );
    const records = repository.listDeveloperActions("run-1", "t1");
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("failed");
  });

  it("rejects a symlink escape for list_files by skipping the escaping entry rather than following it", async () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    writeFileSync(path.join(outside, "secret.txt"), "top secret");
    symlinkSync(outside, path.join(workspace, "escape-link"));
    writeFileSync(path.join(workspace, "visible.txt"), "ok");
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      { content: JSON.stringify({ action: { type: "list_files" } }) },
      {
        content: JSON.stringify({
          action: { type: "done", ...DONE_ALL_EMPTY },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    const result = await developer.run(makeTask());
    const listing = result.actionResults[0]!.entries!;
    expect(listing.map((e) => e.path)).toContain("visible.txt");
    expect(listing.some((e) => e.path.includes("secret"))).toBe(false);
  });

  it("list_files ordering is deterministic and bounded by maxResults", async () => {
    const workspace = makeWorkspace();
    for (const name of ["c.txt", "a.txt", "b.txt", "d.txt"]) {
      writeFileSync(path.join(workspace, name), "x");
    }
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: { type: "list_files", maxResults: 2 },
        }),
      },
      {
        content: JSON.stringify({
          action: { type: "done", ...DONE_ALL_EMPTY },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    const result = await developer.run(makeTask());
    const listing = result.actionResults[0]!;
    expect(listing.entries).toEqual([
      { path: "a.txt", type: "file" },
      { path: "b.txt", type: "file" },
    ]);
    expect(listing.truncated).toBe(true);
  });

  it("redacts secret-shaped content out of read_file and search_text results", async () => {
    const workspace = makeWorkspace();
    writeFileSync(
      path.join(workspace, "config.txt"),
      'api_key: "sk-abcdefghijklmnopqrstuvwx"',
    );
    const { repository, events, executor } = makeHarness(workspace);
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          action: { type: "read_file", path: "config.txt" },
        }),
      },
      {
        content: JSON.stringify({
          action: { type: "done", ...DONE_ALL_EMPTY },
        }),
      },
    ]);
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
    );

    const result = await developer.run(makeTask());
    expect(result.actionResults[0]!.content).toContain("[REDACTED]");
    expect(result.actionResults[0]!.content).not.toContain(
      "sk-abcdefghijklmnopqrstuvwx",
    );
  });

  it("terminates deterministically on the action-count budget instead of looping forever", async () => {
    const workspace = makeWorkspace();
    writeFileSync(path.join(workspace, "f.txt"), "x");
    const { repository, events, executor } = makeHarness(workspace);
    let calls = 0;
    const provider = new MockProvider(() => {
      calls += 1;
      return {
        content: JSON.stringify({
          action: { type: "read_file", path: "f.txt" },
        }),
      };
    });
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
      {
        maxActions: 3,
        wallTimeMs: 60_000,
      },
    );

    const result = await developer.run(makeTask());
    expect(result.outcome).toEqual({
      status: "blocked",
      reason: "ACTION_LIMIT_EXCEEDED",
      detail: "Developer loop exceeded its 3-action budget.",
    });
    expect(calls).toBe(3);
    expect(result.actionResults).toHaveLength(3);
  });

  it("terminates deterministically on the wall-time budget instead of looping forever", async () => {
    const workspace = makeWorkspace();
    writeFileSync(path.join(workspace, "f.txt"), "x");
    const { repository, events, executor } = makeHarness(workspace);
    const provider = new MockProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        content: JSON.stringify({
          action: { type: "read_file", path: "f.txt" },
        }),
      };
    });
    const context = makeContext(repository, events, provider);
    const developer = new DeveloperAgent(
      provider,
      "m",
      context,
      executor,
      repository,
      {
        maxActions: 1000,
        wallTimeMs: 15,
      },
    );

    const result = await developer.run(makeTask());
    expect(result.outcome.status).toBe("blocked");
    if (result.outcome.status === "blocked") {
      expect(result.outcome.reason).toBe("WALL_TIME_EXCEEDED");
    }
  }, 10_000);

  it("does not replay a completed side-effecting action's write when the same request is issued again (Executor idempotency), across two separate DeveloperAgent.run calls simulating a resumed task", async () => {
    const workspace = makeWorkspace();
    const { repository, events, executor } = makeHarness(workspace);
    const action = {
      type: "write_file" as const,
      path: "once.txt",
      content: "v1",
    };

    const provider1 = scriptedProvider([
      { content: JSON.stringify({ action }) },
      {
        content: JSON.stringify({
          action: {
            type: "done",
            ...DONE_ALL_EMPTY,
            changedFiles: ["once.txt"],
          },
        }),
      },
    ]);
    const context1 = makeContext(repository, events, provider1);
    const developer1 = new DeveloperAgent(
      provider1,
      "m",
      context1,
      executor,
      repository,
    );
    await developer1.run(makeTask());
    expect(readFileSync(path.join(workspace, "once.txt"), "utf8")).toBe("v1");

    // Mutate the file out-of-band, then simulate a resumed task re-issuing
    // the exact same write_file request (e.g. the model re-derives the same
    // plan after a crash without seeing the old conversation) — the
    // Executor's idempotency cache must skip the actual write.
    writeFileSync(path.join(workspace, "once.txt"), "mutated-externally");
    const provider2 = scriptedProvider([
      { content: JSON.stringify({ action }) },
      {
        content: JSON.stringify({
          action: {
            type: "done",
            ...DONE_ALL_EMPTY,
            changedFiles: ["once.txt"],
          },
        }),
      },
    ]);
    const context2 = makeContext(repository, events, provider2);
    const developer2 = new DeveloperAgent(
      provider2,
      "m",
      context2,
      executor,
      repository,
    );
    await developer2.run(makeTask({ id: "t1" }));

    expect(readFileSync(path.join(workspace, "once.txt"), "utf8")).toBe(
      "mutated-externally",
    );
  });
});

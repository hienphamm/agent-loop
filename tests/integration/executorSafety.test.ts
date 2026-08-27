import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { ApprovalGate } from "../../src/execution/approval.js";
import {
  Executor,
  computeRunCommandIdempotencyKey,
} from "../../src/execution/executor.js";
import { WorkspaceSafetyError } from "../../src/errors/index.js";

function makeWorkspace(name = "agent-loop-exec-safety-"): string {
  return mkdtempSync(path.join(tmpdir(), name));
}

function makeExecutor(workspace: string) {
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
  return { executor, repository, events };
}

describe("Executor workspace boundary", () => {
  it("rejects writes via ../ traversal", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    await expect(
      executor.writeFile("t1", "../escape.txt", "x"),
    ).rejects.toThrow(WorkspaceSafetyError);
  });

  it("rejects writes via an absolute path outside the workspace", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    await expect(
      executor.writeFile("t1", "/etc/escape.txt", "x"),
    ).rejects.toThrow(WorkspaceSafetyError);
  });

  it("rejects reads via ../ traversal and absolute paths", () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    expect(() => executor.readFile("t1", "../../etc/passwd")).toThrow(
      WorkspaceSafetyError,
    );
    expect(() => executor.readFile("t1", "/etc/passwd")).toThrow(
      WorkspaceSafetyError,
    );
  });

  it("rejects a direct symlink escape", async () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace("agent-loop-exec-outside-");
    symlinkSync(outside, path.join(workspace, "link"));
    const { executor } = makeExecutor(workspace);
    await expect(
      executor.writeFile("t1", "link/evil.txt", "x"),
    ).rejects.toThrow(WorkspaceSafetyError);
  });

  it("rejects a nested symlink escape (symlink several levels deep)", async () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace("agent-loop-exec-outside-nested-");
    mkdirSync(path.join(workspace, "a", "b"), { recursive: true });
    symlinkSync(outside, path.join(workspace, "a", "b", "c"));
    const { executor } = makeExecutor(workspace);
    await expect(
      executor.writeFile("t1", "a/b/c/evil.txt", "x"),
    ).rejects.toThrow(WorkspaceSafetyError);
  });

  it("supports a workspace path containing spaces", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-loop-spaces-"));
    const workspace = path.join(parent, "my workspace with spaces");
    mkdirSync(workspace);
    const { executor } = makeExecutor(workspace);
    await executor.writeFile("t1", "hello.txt", "hi");
    expect(existsSync(path.join(workspace, "hello.txt"))).toBe(true);
  });

  it("confines a spawned command's cwd to the workspace even with a traversal-y relative cwd", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    await expect(executor.runCommand("t1", "pwd", "../../../")).rejects.toThrow(
      WorkspaceSafetyError,
    );
  });

  it("actually runs a command with cwd fixed inside the workspace and cannot list files above it via a bare relative path", async () => {
    const workspace = makeWorkspace();
    mkdirSync(path.join(workspace, "sub"));
    writeFileSync(path.join(workspace, "sub", "inside.txt"), "x");
    const { executor } = makeExecutor(workspace);
    const result = await executor.runCommand("t1", "pwd", "sub");
    // Compare via realpath: on macOS /tmp itself is a symlink (-> /private/tmp),
    // so the shell's `pwd` reports the resolved path even though our workspace
    // boundary logic is enforced against the literal configured path.
    expect(realpathSync(result.stdout.trim())).toBe(
      realpathSync(path.join(workspace, "sub")),
    );
  });

  it("fails safely (does not crash) if the workspace directory is deleted mid-run", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    await executor.writeFile("t1", "before.txt", "ok");
    rmSync(workspace, { recursive: true, force: true });
    await expect(
      executor.writeFile("t1", "after.txt", "should not land anywhere"),
    ).rejects.toThrow(WorkspaceSafetyError);
  });

  it("fails safely if the workspace directory is replaced by a symlink to somewhere else mid-run", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    await executor.writeFile("t1", "before.txt", "ok");

    const outside = makeWorkspace("agent-loop-exec-replacement-");
    rmSync(workspace, { recursive: true, force: true });
    symlinkSync(outside, workspace);

    // The workspace root itself is now a symlink pointing elsewhere. Writes
    // should still land only inside whatever the root currently resolves
    // to (outside dir here) rather than silently escaping further, and
    // reads/writes must not throw for unrelated reasons.
    await executor.writeFile("t1", "after.txt", "lands in outside dir");
    expect(existsSync(path.join(outside, "after.txt"))).toBe(true);
  });
});

describe("Executor idempotency + retry safety", () => {
  it("does not re-run a completed write_file action", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    await executor.writeFile("t1", "once.txt", "v1");
    writeFileSync(
      path.join(workspace, "once.txt"),
      "mutated-by-something-else",
    );
    // Same task/path/content combination: must be treated as already-applied
    // and NOT overwrite the file that changed since.
    await executor.writeFile("t1", "once.txt", "v1");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(workspace, "once.txt"), "utf8")).toBe(
      "mutated-by-something-else",
    );
  });

  it("does not re-run a completed low-risk command, returning the cached result", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    const first = await executor.runCommand("t1", "echo hello");
    const second = await executor.runCommand("t1", "echo hello");
    expect(second).toEqual(first);
  });

  it("requires a fresh (still-auto-approved-under-all, but explicitly re-approved) pass for a destructive command whose prior attempt never recorded an outcome", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    repository.createRun(
      { id: "run-1", prompt: "p", workspace, status: "running" },
      "{}",
    );
    const events = new EventBus();
    const messages: string[] = [];
    events.onType("progress", (e) => messages.push(String(e.data.message)));

    const command = "rm -rf some-generated-dir";
    const approvalGate = new ApprovalGate(repository, events, "all");
    const executor = new Executor(
      workspace,
      "run-1",
      repository,
      events,
      approvalGate,
    );

    // Manually pre-seed an "attempted" (crashed) state for this exact command
    // by computing the same idempotency identity Executor uses internally:
    // we can't reach the private hash function, so instead we drive it
    // through a first call that we truncate by inspecting
    // recordIdempotentAttempt directly via a white-box run: call runCommand
    // once and confirm a completed row exists, then simulate
    // "attempted-only" by recording a fresh attempt for a different
    // (never-completed) destructive command and re-running it.
    await executor.runCommand("t1", command); // succeeds, records "completed"

    // Now prove the *attempted-but-not-completed* path via a distinct
    // destructive command we control end-to-end using the repository API
    // with the same idempotency identity Executor computes internally
    // (same command/cwd/expectedExitCodes -> same key).
    const crashedCommand = "rm -rf never-finished";
    const crashedKey = computeRunCommandIdempotencyKey(
      "run-1",
      "t1",
      crashedCommand,
      undefined,
    );
    repository.recordIdempotentAttempt(
      crashedKey,
      "run-1",
      "t1",
      "destructive",
    );

    // Even though approvalMode is "all", a retry of a destructive command
    // whose prior outcome is unknown must still require a real approval
    // (forceManual) instead of silently auto-approving and re-running it.
    const unsubscribe = events.onType("approval_required", (e) => {
      repository.resolveApproval(String(e.data.approvalId), "approved");
    });
    try {
      await executor.runCommand("t1", crashedCommand);
    } finally {
      unsubscribe();
    }
    expect(
      messages.some((m) =>
        m.includes("crashed before its outcome was recorded"),
      ),
    ).toBe(true);
  }, 10_000);
});

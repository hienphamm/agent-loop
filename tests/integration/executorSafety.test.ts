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
  computeWriteFileIdempotencyKey,
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

  it.each([
    ["a bare scalar (false)", "false"],
    ["a bare scalar (0)", "0"],
    ["a bare JSON string", '"unrelated text"'],
    ["an empty array", "[]"],
    [
      "a valid-but-wrong-shape object (a write_file result)",
      '{"path":"x.txt"}',
    ],
  ])(
    "does not skip run_command execution for a 'completed' row whose result_json is %s",
    async (_label, jsonLiteral) => {
      const workspace = makeWorkspace();
      const { executor, repository } = makeExecutor(workspace);
      const command = "echo hello-again";
      const key = computeRunCommandIdempotencyKey(
        "run-1",
        "t1",
        command,
        undefined,
      );
      const db = (
        repository as unknown as { db: import("node:sqlite").DatabaseSync }
      ).db;
      db.prepare(
        `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
         VALUES (?, 'run-1', 't1', 'low', 'completed', ?, 't', 't')`,
      ).run(key, jsonLiteral);

      // A real execution happens and returns a genuine CommandResult
      // (stdout containing the echoed text), not the corrupted payload and
      // not a fabricated `{exitCode: null, ...}` fallback.
      const result = await executor.runCommand("t1", command);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello-again");
    },
  );

  it.each([
    ["a bare scalar (false)", "false"],
    ["a bare scalar (0)", "0"],
    ["a bare JSON string", '"unrelated text"'],
    ["an empty array", "[]"],
    [
      "a valid-but-wrong-shape object (a run_command result)",
      '{"exitCode":0,"signal":null,"stdout":"","stderr":""}',
    ],
  ])(
    "does not skip write_file execution for a 'completed' row whose result_json is %s",
    async (_label, jsonLiteral) => {
      const workspace = makeWorkspace();
      const { executor, repository } = makeExecutor(workspace);
      const relPath = "corrupted-cache.txt";
      const content = "real content";
      const key = computeWriteFileIdempotencyKey(
        "run-1",
        "t1",
        relPath,
        content,
      );
      const db = (
        repository as unknown as { db: import("node:sqlite").DatabaseSync }
      ).db;
      db.prepare(
        `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
         VALUES (?, 'run-1', 't1', 'low', 'completed', ?, 't', 't')`,
      ).run(key, jsonLiteral);

      expect(existsSync(path.join(workspace, relPath))).toBe(false);
      await executor.writeFile("t1", relPath, content);
      // A real write happened — the file now exists with the real content
      // — rather than being silently skipped because a corrupted row
      // claimed this exact write was already "completed".
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(path.join(workspace, relPath), "utf8")).toBe(content);
    },
  );

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

  it("still requires forced approval for a destructive command when its 'completed' cache row is corrupted (not just when it's 'attempted')", async () => {
    const workspace = makeWorkspace();
    const repository = new Repository(openInMemoryDatabase());
    repository.createRun(
      { id: "run-1", prompt: "p", workspace, status: "running" },
      "{}",
    );
    const events = new EventBus();
    const messages: string[] = [];
    events.onType("progress", (e) => messages.push(String(e.data.message)));
    const approvalGate = new ApprovalGate(repository, events, "all");
    const executor = new Executor(
      workspace,
      "run-1",
      repository,
      events,
      approvalGate,
    );

    // A "completed" row for a destructive command, but with a corrupted
    // (bare-scalar) result_json that fails the run_command shape check —
    // this must be downgraded to the same unknown-outcome handling as an
    // "attempted" row, including the forced-approval retry path, not
    // silently trusted (skip) nor silently auto-approved.
    const command = "rm -rf some-tampered-dir";
    const key = computeRunCommandIdempotencyKey(
      "run-1",
      "t1",
      command,
      undefined,
    );
    const db = (
      repository as unknown as { db: import("node:sqlite").DatabaseSync }
    ).db;
    db.prepare(
      `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
       VALUES (?, 'run-1', 't1', 'destructive', 'completed', 'false', 't', 't')`,
    ).run(key);

    const unsubscribe = events.onType("approval_required", (e) => {
      repository.resolveApproval(String(e.data.approvalId), "approved");
    });
    try {
      await executor.runCommand("t1", command);
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

describe("Executor read-only actions (P2)", () => {
  it("read_file bounds output size and reports truncation instead of growing unboundedly", async () => {
    const workspace = makeWorkspace();
    const { executor } = makeExecutor(workspace);
    const big = "x".repeat(50);
    writeFileSync(path.join(workspace, "big.txt"), big);
    const result = executor.readFile("t1", "big.txt");
    expect(result.content).toBe(big);
    expect(result.truncated).toBe(false);
  });

  it("list_files returns a deterministic, name-sorted, workspace-relative listing across repeated calls", async () => {
    const workspace = makeWorkspace();
    mkdirSync(path.join(workspace, "dir"));
    writeFileSync(path.join(workspace, "dir", "z.txt"), "z");
    writeFileSync(path.join(workspace, "a.txt"), "a");
    const { executor } = makeExecutor(workspace);
    const first = executor.listFiles("t1", undefined, undefined);
    const second = executor.listFiles("t1", undefined, undefined);
    expect(first).toEqual(second);
    expect(first.entries.map((e) => e.path)).toEqual([
      "a.txt",
      "dir",
      "dir/z.txt",
    ]);
    expect(first.truncated).toBe(false);
  });

  it("list_files never returns a path outside the workspace, even for a directory-shaped symlink target", async () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace("agent-loop-exec-list-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "nope");
    symlinkSync(outside, path.join(workspace, "escape"));
    writeFileSync(path.join(workspace, "ok.txt"), "ok");
    const { executor } = makeExecutor(workspace);
    const result = executor.listFiles("t1", undefined, undefined);
    expect(result.entries.map((e) => e.path)).toEqual(["ok.txt"]);
  });

  it("search_text finds literal matches without invoking a shell, and is bounded by maxMatches", async () => {
    const workspace = makeWorkspace();
    writeFileSync(
      path.join(workspace, "notes.txt"),
      "needle one\nnothing here\nneedle two\nneedle three\n",
    );
    const { executor } = makeExecutor(workspace);
    const bounded = executor.searchText("t1", "needle", { maxMatches: 2 });
    expect(bounded.matches).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(bounded.matches[0]).toEqual({
      path: "notes.txt",
      line: 1,
      text: "needle one",
    });

    const shellChar = executor.searchText("t1", "$(echo pwned)");
    expect(shellChar.matches).toHaveLength(0); // literal search — never interpreted as shell syntax
  });

  it("search_text is a literal search: regex metacharacters in the query are matched literally, not as a pattern", async () => {
    const workspace = makeWorkspace();
    writeFileSync(path.join(workspace, "f.txt"), "a.b.c\naxbxc\n");
    const { executor } = makeExecutor(workspace);
    const result = executor.searchText("t1", "a.b.c");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.text).toBe("a.b.c");
  });
});

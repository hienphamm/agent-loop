import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
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
  normalizeExpectedExitCodes,
} from "../../src/execution/executor.js";
import {
  registerSecret,
  clearRegisteredSecrets,
} from "../../src/auth/redact.js";
import {
  ActionValidationError,
  CommandFailureError,
} from "../../src/errors/index.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-exit-codes-"));
}

function makeExecutor(
  options?: ConstructorParameters<typeof Executor>[5],
  approvalMode: "all" | "manual" | "safe" = "all",
) {
  const workspace = makeWorkspace();
  const repository = new Repository(openInMemoryDatabase());
  repository.createRun(
    { id: "run-1", prompt: "p", workspace, status: "running" },
    "{}",
  );
  const events = new EventBus();
  const commandCompletedEvents: Record<string, unknown>[] = [];
  events.onType("command_completed", (e) =>
    commandCompletedEvents.push(e.data),
  );
  // A real process is only ever spawned right after this event fires (never
  // on a cache hit or an approval rejection), so counting it is a
  // deterministic proxy for "did the command actually execute again".
  let commandStartedCount = 0;
  events.onType("command_started", () => {
    commandStartedCount += 1;
  });
  const progressMessages: string[] = [];
  events.onType("progress", (e) =>
    progressMessages.push(String(e.data.message ?? "")),
  );
  const approvalGate = new ApprovalGate(repository, events, approvalMode);
  const executor = new Executor(
    workspace,
    "run-1",
    repository,
    events,
    approvalGate,
    options,
  );
  return {
    executor,
    repository,
    events,
    commandCompletedEvents,
    progressMessages,
    getCommandStartedCount: () => commandStartedCount,
    workspace,
  };
}

describe("normalizeExpectedExitCodes", () => {
  it("defaults to [0] when omitted", () => {
    expect(normalizeExpectedExitCodes(undefined)).toEqual([0]);
  });

  it("dedupes and sorts", () => {
    expect(normalizeExpectedExitCodes([2, 0, 2, 1])).toEqual([0, 1, 2]);
  });

  it("rejects an empty array (must not accidentally accept everything)", () => {
    expect(() => normalizeExpectedExitCodes([])).toThrow(
      ActionValidationError,
    );
  });

  it("rejects non-integer values", () => {
    expect(() => normalizeExpectedExitCodes([1.5])).toThrow(
      ActionValidationError,
    );
  });

  it("rejects values outside the valid exit-code range", () => {
    expect(() => normalizeExpectedExitCodes([-1])).toThrow(
      ActionValidationError,
    );
    expect(() => normalizeExpectedExitCodes([256])).toThrow(
      ActionValidationError,
    );
  });

  it("rejects non-number entries", () => {
    expect(() => normalizeExpectedExitCodes(["0"])).toThrow(
      ActionValidationError,
    );
  });
});

describe("Executor.runCommand exit-code semantics", () => {
  it("succeeds on exit 0 when expectedExitCodes is omitted", async () => {
    const { executor } = makeExecutor();
    const result = await executor.runCommand("t1", "exit 0");
    expect(result.exitCode).toBe(0);
  });

  it("fails on exit 1 when expectedExitCodes is omitted (does not silently succeed)", async () => {
    const { executor, commandCompletedEvents } = makeExecutor();
    const error = await executor
      .runCommand("t1", "exit 1")
      .catch((e) => e as CommandFailureError);
    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).code).toBe("UNEXPECTED_EXIT_CODE");
    expect((error as CommandFailureError).actualExitCode).toBe(1);
    expect((error as CommandFailureError).expectedExitCodes).toEqual([0]);

    const failedEvent = commandCompletedEvents.find(
      (e) => e.success === false,
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.failureReason).toBe("UNEXPECTED_EXIT_CODE");
    expect(failedEvent!.exitCode).toBe(1);
  });

  it("succeeds on exit 1 when expectedExitCodes explicitly includes 1", async () => {
    const { executor } = makeExecutor();
    const result = await executor.runCommand("t1", "exit 1", undefined, [
      0, 1,
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("rejects an invalid expectedExitCodes deterministically before running anything", async () => {
    const { executor, commandCompletedEvents } = makeExecutor();
    await expect(
      executor.runCommand("t1", "exit 0", undefined, []),
    ).rejects.toThrow(ActionValidationError);
    // Never even got to spawning/emitting a command_completed event.
    expect(commandCompletedEvents.length).toBe(0);
  });

  it("distinguishes termination by signal from an unexpected exit code", async () => {
    const { executor, commandCompletedEvents } = makeExecutor();
    // `kill -TERM $$` sends SIGTERM to the running shell itself.
    const error = await executor
      .runCommand("t1", "kill -TERM $$")
      .catch((e) => e as CommandFailureError);
    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).code).toBe("TERMINATED_BY_SIGNAL");
    expect((error as CommandFailureError).signal).toBe("SIGTERM");
    expect((error as CommandFailureError).actualExitCode).toBeNull();

    const failedEvent = commandCompletedEvents.find(
      (e) => e.success === false,
    );
    expect(failedEvent!.failureReason).toBe("TERMINATED_BY_SIGNAL");
  });

  it("distinguishes an output-limit kill from an ordinary external signal/timeout", async () => {
    const { executor, commandCompletedEvents } = makeExecutor({
      maxOutputBytes: 100,
      killGraceMs: 200,
    });
    // Writes far more than the 100-byte cap; the executor kills it for
    // exceeding maxOutputBytes, not because of the (10-minute default)
    // timeout and not because of some external signal.
    const error = await executor
      .runCommand("t1", "head -c 200000 /dev/zero")
      .catch((e) => e as CommandFailureError);
    expect(error).toBeInstanceOf(CommandFailureError);
    // It resolves via signal (the kill mechanism), but must be marked
    // `truncated` so it's not indistinguishable from an unrelated external
    // kill — and must NOT be reported as a timeout.
    expect((error as CommandFailureError).code).toBe("TERMINATED_BY_SIGNAL");
    expect((error as CommandFailureError).truncated).toBe(true);
    expect((error as CommandFailureError).timedOut).toBe(false);

    const failedEvent = commandCompletedEvents.find(
      (e) => e.success === false,
    );
    expect(failedEvent!.truncated).toBe(true);
  }, 10_000);

  it("distinguishes a timeout from an unexpected exit code", async () => {
    const { executor } = makeExecutor({ timeoutMs: 50, killGraceMs: 50 });
    const error = await executor
      .runCommand("t1", "sleep 5")
      .catch((e) => e as CommandFailureError);
    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).code).toBe("COMMAND_TIMEOUT");
    expect((error as CommandFailureError).truncated).toBe(false);
  }, 10_000);

  it("reports a spawn failure distinctly, without pretending it was an exit code", async () => {
    const { executor } = makeExecutor();
    // A cwd that does not exist on disk makes the OS spawn call itself
    // fail before the shell ever runs: a genuine spawn failure, not an
    // exit code. resolveWorkspacePath only enforces containment, not
    // existence, so this reaches spawn() unmodified.
    const error = await executor
      .runCommand("t1", "echo bad", "does-not-exist")
      .catch((e) => e as CommandFailureError);
    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).code).toBe("COMMAND_SPAWN_FAILED");
    expect((error as CommandFailureError).actualExitCode).toBeNull();
  });

  it("redacts secrets from stdout/stderr and the error message on failure", async () => {
    registerSecret("super-secret-token-value");
    try {
      const { executor } = makeExecutor();
      const error = await executor
        .runCommand("t1", "echo super-secret-token-value 1>&2; exit 1")
        .catch((e) => e as CommandFailureError);
      expect(error).toBeInstanceOf(CommandFailureError);
      const failure = error as CommandFailureError;
      expect(failure.message).not.toContain("super-secret-token-value");
      expect(failure.stderrTail ?? "").not.toContain(
        "super-secret-token-value",
      );
    } finally {
      clearRegisteredSecrets();
    }
  });

  it("does not leak a partial secret when its occurrence straddles the diagnostic truncation boundary", async () => {
    // Regression for a truncate-before-redact ordering bug: redact() only
    // matches a *complete* occurrence of a registered secret, so slicing
    // the diagnostic down to its last 2000 characters before redacting
    // could cut a secret in half at that boundary and leave the surviving
    // fragment (e.g. the secret's last 20 characters) unredacted. Placing
    // the secret so only its tail falls within the last-2000-char window
    // reproduces exactly that boundary.
    const secret = "S3CR3T-" + "9".repeat(33); // 40 chars, unique.
    registerSecret(secret);
    try {
      const { executor } = makeExecutor();
      const filler = "z".repeat(1980);
      // secret(40) + filler(1980) = 2020 chars; the last 2000 keep only
      // the secret's final 20 characters plus all of filler.
      const payload = secret + filler;
      const command = `printf '%s' '${payload}' 1>&2; exit 1`;
      const error = await executor
        .runCommand("t1", command)
        .catch((e) => e as CommandFailureError);
      expect(error).toBeInstanceOf(CommandFailureError);
      const tail = (error as CommandFailureError).stderrTail ?? "";
      expect(tail).not.toContain(secret);
      // No fragment (rotating substring) of the secret survives either.
      expect(tail).not.toContain(secret.slice(20));
      expect(tail).not.toContain(secret.slice(-10));
    } finally {
      clearRegisteredSecrets();
    }
  });
});

describe("run_command idempotency", () => {
  it("(1) never stores or returns a failed command as a successful cached result", async () => {
    const { executor, getCommandStartedCount } = makeExecutor();
    const first = await executor
      .runCommand("t1", "exit 1")
      .catch((e) => e as CommandFailureError);
    expect(first).toBeInstanceOf(CommandFailureError);
    expect(getCommandStartedCount()).toBe(1);

    // If the failure had been cached as "completed", this second call would
    // short-circuit before ever reaching command_started.
    const second = await executor
      .runCommand("t1", "exit 1")
      .catch((e) => e as CommandFailureError);
    expect(second).toBeInstanceOf(CommandFailureError);
    expect(getCommandStartedCount()).toBe(2);
  });

  it("does not skip execution for a corrupted 'completed' row with a NULL result_json", async () => {
    // A "completed" row is only ever written together with a real
    // result_json by recordIdempotentResult. Directly seed a corrupted row
    // (status='completed', result_json=NULL) — as could arise from a torn
    // write or tampering — bypassing Executor entirely, then prove
    // Executor.runCommand does NOT treat it as a trustworthy cache hit: it
    // must actually re-execute the command rather than returning the
    // fabricated `{exitCode: null, ...}` fallback checkCache would produce
    // for a blindly-trusted "completed" skip.
    const { executor, repository, getCommandStartedCount } = makeExecutor();
    const command = "exit 0";
    const key = computeRunCommandIdempotencyKey("run-1", "t1", command, undefined);
    const db = (repository as unknown as { db: import("node:sqlite").DatabaseSync })
      .db;
    db.prepare(
      `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
       VALUES (?, 'run-1', 't1', 'low', 'completed', NULL, 't', 't')`,
    ).run(key);

    expect(getCommandStartedCount()).toBe(0);
    const result = await executor.runCommand("t1", command);
    // A real execution happened (command_started fired) rather than a
    // silent skip-with-fabricated-result.
    expect(getCommandStartedCount()).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it("(2)+(3) persists a known failure as 'failed' (not unknown 'attempted'), and a retry actually re-executes it without forcing approval", async () => {
    const { executor, repository, progressMessages, getCommandStartedCount } =
      makeExecutor();
    // Classified "destructive" (matches the `dd if=` pattern) so that, if
    // this were mis-persisted as an unknown-outcome "attempted" crash, the
    // next call would require a forced manual approval (see
    // executorSafety.test.ts for that contrasting case).
    const command = "dd if=/dev/null of=/dev/null count=1 2>/dev/null; exit 1";

    await executor.runCommand("t1", command).catch(() => undefined);
    expect(getCommandStartedCount()).toBe(1);

    const key = computeRunCommandIdempotencyKey("run-1", "t1", command, undefined);
    const state = repository.getIdempotencyState(key);
    expect(state?.status).toBe("failed");
    expect((state?.result as { code?: string } | undefined)?.code).toBe(
      "UNEXPECTED_EXIT_CODE",
    );

    // Retrying re-executes the command (a known failure is safe to just
    // run again) and does not go through the "crashed before its outcome
    // was recorded" forced-approval path.
    const second = await executor
      .runCommand("t1", command)
      .catch((e) => e as CommandFailureError);
    expect(second).toBeInstanceOf(CommandFailureError);
    expect(getCommandStartedCount()).toBe(2);
    expect(
      progressMessages.some((m) =>
        m.includes("crashed before its outcome was recorded"),
      ),
    ).toBe(false);
  });

  it("(4) an unknown (crashed) attempted action still requires forced approval before retrying", async () => {
    const { executor, repository, events, progressMessages } =
      makeExecutor();
    const command = "dd if=/dev/null of=/dev/null count=1 2>/dev/null";
    const key = computeRunCommandIdempotencyKey("run-1", "t1", command, undefined);
    // Simulate a crash mid-execution: an "attempted" row with no result,
    // exactly as recordIdempotentAttempt leaves it if the process dies
    // before recordIdempotentResult/recordIdempotentFailure ever runs.
    repository.recordIdempotentAttempt(key, "run-1", "t1", "destructive");

    const unsubscribe = events.onType("approval_required", (e) => {
      repository.resolveApproval(String(e.data.approvalId), "approved");
    });
    try {
      await executor.runCommand("t1", command);
    } finally {
      unsubscribe();
    }
    expect(
      progressMessages.some((m) =>
        m.includes("crashed before its outcome was recorded"),
      ),
    ).toBe(true);
  });

  it("(5) a success cached under [0, 1] is not reused under [0]", async () => {
    const { executor, getCommandStartedCount } = makeExecutor();
    const first = await executor.runCommand("t1", "exit 1", undefined, [
      0, 1,
    ]);
    expect(first.exitCode).toBe(1);
    expect(getCommandStartedCount()).toBe(1);

    const second = await executor
      .runCommand("t1", "exit 1", undefined, [0])
      .catch((e) => e as CommandFailureError);
    expect(second).toBeInstanceOf(CommandFailureError);
    // A different policy is a different identity: it must have actually
    // re-executed rather than returning the [0,1] success from cache.
    expect(getCommandStartedCount()).toBe(2);
  });

  it("(6) equivalent normalized policies [1, 0, 1] and [0, 1] share the same cached identity", async () => {
    const { executor, getCommandStartedCount } = makeExecutor();
    const first = await executor.runCommand("t1", "exit 0", undefined, [
      1, 0, 1,
    ]);
    expect(first.exitCode).toBe(0);
    expect(getCommandStartedCount()).toBe(1);

    const second = await executor.runCommand("t1", "exit 0", undefined, [
      0, 1,
    ]);
    expect(second).toEqual(first);
    // Cache hit: no second real execution.
    expect(getCommandStartedCount()).toBe(1);
  });

  it("(7) an omitted expectedExitCodes and an explicit [0] share the same cached identity", async () => {
    const { executor, getCommandStartedCount } = makeExecutor();
    const first = await executor.runCommand("t1", "exit 0");
    expect(getCommandStartedCount()).toBe(1);

    const second = await executor.runCommand("t1", "exit 0", undefined, [0]);
    expect(second).toEqual(first);
    expect(getCommandStartedCount()).toBe(1);
  });

  it("(8) APPROVAL_REJECTED is not retried", async () => {
    const { isRetryableError } = await import(
      "../../src/orchestration/retry.js"
    );
    const { executor, repository, events, getCommandStartedCount } =
      makeExecutor(undefined, "manual");
    const unsubscribe = events.onType("approval_required", (e) => {
      repository.resolveApproval(String(e.data.approvalId), "rejected");
    });
    let error: CommandFailureError | undefined;
    try {
      await executor
        .runCommand("t1", "exit 0")
        .catch((e) => (error = e as CommandFailureError));
    } finally {
      unsubscribe();
    }
    expect(error).toBeInstanceOf(CommandFailureError);
    expect(error!.reason).toBe("APPROVAL_REJECTED");
    expect(isRetryableError(error)).toBe(false);
    // Rejection happens before command_started is ever emitted.
    expect(getCommandStartedCount()).toBe(0);
  });

  it("(9) persisted failure diagnostics are redacted and bounded", async () => {
    registerSecret("super-secret-token-value");
    try {
      const { executor, repository } = makeExecutor();
      const command =
        "echo super-secret-token-value 1>&2; exit 1";
      await executor.runCommand("t1", command).catch(() => undefined);

      const key = computeRunCommandIdempotencyKey(
        "run-1",
        "t1",
        command,
        undefined,
      );
      const state = repository.getIdempotencyState(key);
      expect(state?.status).toBe("failed");
      const persisted = JSON.stringify(state?.result);
      expect(persisted).not.toContain("super-secret-token-value");
      expect(persisted.length).toBeLessThan(5000);
    } finally {
      clearRegisteredSecrets();
    }
  });
});

describe("idempotency key encoding (field-boundary safety)", () => {
  it("does not collide two distinct run_command tuples via a shifted whitespace boundary", () => {
    // Both of these joined with a plain space would produce the identical
    // string "exit 0 a b" — a real collision under the old `parts.join(" ")`
    // encoding despite being two clearly distinct (command, cwd) pairs.
    const keyA = computeRunCommandIdempotencyKey(
      "r",
      "t",
      "exit 0",
      "a b",
      [0],
    );
    const keyB = computeRunCommandIdempotencyKey(
      "r",
      "t",
      "exit 0 a",
      "b",
      [0],
    );
    expect(keyA).not.toBe(keyB);
  });

  it("still shares an identity for equivalent normalized expectedExitCodes", () => {
    const keyA = computeRunCommandIdempotencyKey("r", "t", "cmd", undefined, [
      1, 0, 1,
    ]);
    const keyB = computeRunCommandIdempotencyKey("r", "t", "cmd", undefined, [
      0, 1,
    ]);
    expect(keyA).toBe(keyB);
  });

  it("still shares an identity between an omitted expectedExitCodes and an explicit [0]", () => {
    const keyA = computeRunCommandIdempotencyKey("r", "t", "cmd", undefined);
    const keyB = computeRunCommandIdempotencyKey("r", "t", "cmd", undefined, [
      0,
    ]);
    expect(keyA).toBe(keyB);
  });

  it("does not collide two distinct write_file tuples via a shifted whitespace boundary", () => {
    // Under the old space-joined encoding, ("write_file", "r", "t", "a b", "x")
    // and ("write_file", "r", "t", "a", "b x") both join to the same string.
    const keyA = computeWriteFileIdempotencyKey("r", "t", "a b", "x");
    const keyB = computeWriteFileIdempotencyKey("r", "t", "a", "b x");
    expect(keyA).not.toBe(keyB);
  });

  it("run_command and write_file keys never collide with each other for the same field values", () => {
    // The literal "run_command"/"write_file" discriminator is itself just
    // another JSON-encoded array element now, so no combination of the
    // other fields can forge one kind's key from the other's.
    const runKey = computeRunCommandIdempotencyKey(
      "r",
      "t",
      "write_file",
      undefined,
      [0],
    );
    const writeKey = computeWriteFileIdempotencyKey(
      "r",
      "t",
      "run_command",
      "[0]",
    );
    expect(runKey).not.toBe(writeKey);
  });

  it("end-to-end: two Executor.runCommand calls whose fields only differ by a shifted whitespace boundary do not share a cached result", async () => {
    const { executor, getCommandStartedCount } = makeExecutor();
    // "exit 0" in cwd "sub dir" vs. "exit 0" with a literal trailing space
    // folded into the command instead of the cwd — both would join to the
    // same "exit 0 sub dir" string under the old encoding. Neither cwd nor
    // this command actually needs to exist/succeed identically for this
    // test: what matters is that both are executed (not that the second
    // returns a bogus cached result from the first).
    const first = await executor
      .runCommand("t1", "exit 0", "sub dir")
      .catch((e) => e);
    const second = await executor
      .runCommand("t1", "exit 0 sub", "dir")
      .catch((e) => e);
    // Both attempts actually ran as independent commands (2 real spawns),
    // proving the second was never served from the first's cache entry.
    expect(getCommandStartedCount()).toBe(2);
    void first;
    void second;
  });
});

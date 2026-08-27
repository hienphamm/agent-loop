import { describe, expect, it, beforeEach } from "vitest";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";

describe("Repository", () => {
  let repo: Repository;

  beforeEach(() => {
    repo = new Repository(openInMemoryDatabase());
  });

  it("creates and retrieves a run", () => {
    repo.createRun(
      { id: "run-1", prompt: "do stuff", workspace: "/ws", status: "pending" },
      "{}",
    );
    const run = repo.getRun("run-1");
    expect(run?.status).toBe("pending");
  });

  it("moves a task through its status lifecycle", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    repo.insertTasks("run-1", [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    expect(repo.getTask("run-1", "t1")?.status).toBe("pending");

    repo.updateTaskStatus("run-1", "t1", "running");
    expect(repo.getTask("run-1", "t1")?.status).toBe("running");

    repo.updateTaskStatus("run-1", "t1", "completed");
    expect(repo.getTask("run-1", "t1")?.status).toBe("completed");
  });

  it("tracks retry counts", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    repo.insertTasks("run-1", [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    repo.incrementRetry("run-1", "t1");
    repo.incrementRetry("run-1", "t1");
    expect(repo.getTask("run-1", "t1")?.retryCount).toBe(2);
    repo.recordRetry({
      runId: "run-1",
      taskId: "t1",
      attempt: 1,
      error: "boom",
      backoffMs: 1000,
    });
  });

  it("supports approval create/resolve and pending lookup", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    const approval = repo.createApproval({
      runId: "run-1",
      scope: "plan",
      summary: "approve plan",
    });
    expect(repo.getPendingApproval("run-1")?.id).toBe(approval.id);
    repo.resolveApproval(approval.id, "approved");
    expect(repo.getPendingApproval("run-1")).toBeUndefined();
    expect(repo.listApprovals("run-1")[0]?.status).toBe("approved");
  });

  it("dedupes idempotent side effects by key, distinguishing attempted from completed", () => {
    expect(repo.getIdempotencyState("key-1")).toBeUndefined();

    repo.recordIdempotentAttempt("key-1", "run-1", "t1", "low");
    const attempted = repo.getIdempotencyState("key-1");
    expect(attempted?.status).toBe("attempted");
    expect(attempted?.result).toBeUndefined();

    repo.recordIdempotentResult("key-1", "run-1", "t1", "low", { ok: true });
    const completed = repo.getIdempotencyState("key-1");
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toEqual({ ok: true });
  });

  it("redacts secret-shaped fields before persisting task results", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    repo.insertTasks("run-1", [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    repo.setTaskResult("run-1", "t1", {
      apiKey: "sk-should-not-be-stored",
      output: "fine",
    });
    const task = repo.getTask("run-1", "t1");
    expect(JSON.stringify(task?.result)).not.toContain(
      "sk-should-not-be-stored",
    );
  });

  it("records and reads back a known ('failed') idempotency outcome distinctly from 'attempted'/'completed'", () => {
    repo.recordIdempotentFailure("key-failed", "run-1", "t1", "low", {
      code: "UNEXPECTED_EXIT_CODE",
      actualExitCode: 1,
    });
    const state = repo.getIdempotencyState("key-failed");
    expect(state?.status).toBe("failed");
    expect(state?.result).toEqual({
      code: "UNEXPECTED_EXIT_CODE",
      actualExitCode: 1,
    });
  });

  it("never trusts a corrupt result_json as a verified 'completed' outcome", () => {
    // Directly write a malformed row, bypassing the normal
    // recordIdempotentResult path, to simulate on-disk corruption (a torn
    // write, manual edit, etc.) rather than anything this process itself
    // ever produces.
    const db = (repo as unknown as { db: import("node:sqlite").DatabaseSync })
      .db;
    db.prepare(
      `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
       VALUES ('corrupt-completed', 'run-1', 't1', 'destructive', 'completed', '{not valid json', 't', 't')`,
    ).run();

    const state = repo.getIdempotencyState("corrupt-completed");
    // Must NOT be reported as a trustworthy "completed" cache hit — that
    // would let a corrupted row masquerade as a verified success and skip
    // re-execution entirely. Falls back to the safe "attempted" (unknown
    // outcome) path instead of throwing or silently trusting garbage.
    expect(state?.status).toBe("attempted");
    expect(state?.result).toBeUndefined();
  });

  it("never trusts a 'completed' row with a NULL result_json as a verified outcome", () => {
    // A "completed" status is only ever written together with a real
    // result_json by recordIdempotentResult — a NULL result_json paired
    // with status='completed' can only come from corruption/tampering, not
    // from anything Executor itself produces. Must not be reported as a
    // trustworthy cache hit.
    const db = (repo as unknown as { db: import("node:sqlite").DatabaseSync })
      .db;
    db.prepare(
      `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
       VALUES ('completed-null-result', 'run-1', 't1', 'low', 'completed', NULL, 't', 't')`,
    ).run();

    const state = repo.getIdempotencyState("completed-null-result");
    expect(state?.status).toBe("attempted");
    expect(state?.result).toBeUndefined();
  });

  it.each([
    ["false", "false"],
    ["0", "0"],
    ["a JSON string", '"text"'],
    ["an empty array", "[]"],
  ])(
    "never trusts a 'completed' row whose result_json is a bare scalar/array (%s)",
    (_label, jsonLiteral) => {
      // A valid *parse* isn't enough: `false`, `0`, `"text"`, and `[]` all
      // parse successfully but are not the object shape Executor ever
      // persists for a real success (write_file -> {path}, run_command ->
      // a CommandResult object). Each must still downgrade to "attempted"
      // rather than being trusted as a completed result.
      const db = (
        repo as unknown as { db: import("node:sqlite").DatabaseSync }
      ).db;
      const key = `completed-scalar-${jsonLiteral}`;
      db.prepare(
        `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
         VALUES (?, 'run-1', 't1', 'low', 'completed', ?, 't', 't')`,
      ).run(key, jsonLiteral);

      const state = repo.getIdempotencyState(key);
      expect(state?.status).toBe("attempted");
      expect(state?.result).toBeUndefined();
    },
  );

  it("does not crash on an unrecognized status value; falls back to the safe 'attempted' path", () => {
    const db = (repo as unknown as { db: import("node:sqlite").DatabaseSync })
      .db;
    db.prepare(
      `INSERT INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
       VALUES ('weird-status', 'run-1', 't1', 'low', 'some-future-status', NULL, 't', 't')`,
    ).run();

    const state = repo.getIdempotencyState("weird-status");
    expect(state?.status).toBe("attempted");
  });

  it("compacts a conversation into a new one carrying the summary", () => {
    const conv = repo.createConversation("run-1", "reviewer");
    const replacement = repo.compactConversation(conv.id, {
      decisions: ["use SQLite"],
      facts: [],
      rules: [],
      artifacts: [],
      openQuestions: [],
    });
    expect(replacement.id).not.toBe(conv.id);
  });
});

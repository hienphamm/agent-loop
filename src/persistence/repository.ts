import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { redactDeep } from "../auth/redact.js";
import type {
  ApprovalRecord,
  CheckpointRecord,
  ConversationRecord,
  MemoryRecord,
  RetryRecord,
  Run,
  RunStatus,
  Task,
  TaskSpec,
  TaskStatus,
} from "../orchestration/types.js";
import type { BaseEvent } from "../events/types.js";

function now(): string {
  return new Date().toISOString();
}

/**
 * All local state access goes through this repository. Every write redacts
 * secrets first, so nothing sensitive can end up in state.db even by accident.
 */
export class Repository {
  constructor(private db: DatabaseSync) {}

  // ---- runs ----------------------------------------------------------
  createRun(
    run: Omit<Run, "createdAt" | "updatedAt">,
    redactedConfigJson: string,
  ): Run {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO runs (id, prompt, workspace, status, config_json, current_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.prompt,
        run.workspace,
        run.status,
        redactedConfigJson,
        run.currentConversationId ?? null,
        ts,
        ts,
      );
    return { ...run, createdAt: ts, updatedAt: ts };
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now(), runId);
  }

  setRunConversation(runId: string, conversationId: string): void {
    this.db
      .prepare(
        `UPDATE runs SET current_conversation_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(conversationId, now(), runId);
  }

  getRun(runId: string): Run | undefined {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE id = ?`)
      .get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(limit = 50): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  // ---- tasks -----------------------------------------------------------
  insertTasks(runId: string, specs: TaskSpec[]): Task[] {
    const ts = now();
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, run_id, description, dependencies_json, scope, risk, acceptance_criteria_json, status, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    );
    const tasks: Task[] = [];
    for (const spec of specs) {
      stmt.run(
        spec.id,
        runId,
        spec.description,
        JSON.stringify(spec.dependencies),
        spec.scope ?? null,
        spec.risk,
        JSON.stringify(spec.acceptanceCriteria),
        ts,
        ts,
      );
      tasks.push({
        ...spec,
        runId,
        status: "pending",
        retryCount: 0,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return tasks;
  }

  getTask(runId: string, taskId: string): Task | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE run_id = ? AND id = ?`)
      .get(runId, taskId) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(runId: string): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  updateTaskStatus(
    runId: string,
    taskId: string,
    status: TaskStatus,
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE run_id = ? AND id = ?`,
      )
      .run(status, error ?? null, now(), runId, taskId);
  }

  setTaskResult(runId: string, taskId: string, result: unknown): void {
    this.db
      .prepare(
        `UPDATE tasks SET result_json = ?, updated_at = ? WHERE run_id = ? AND id = ?`,
      )
      .run(JSON.stringify(redactDeep(result)), now(), runId, taskId);
  }

  incrementRetry(runId: string, taskId: string): number {
    this.db
      .prepare(
        `UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE run_id = ? AND id = ?`,
      )
      .run(now(), runId, taskId);
    return this.getTask(runId, taskId)?.retryCount ?? 0;
  }

  addFollowUpTasks(runId: string, specs: TaskSpec[]): Task[] {
    return this.insertTasks(runId, specs);
  }

  // ---- events ------------------------------------------------------------
  //
  // `seq` here is the durable, globally-ordered sequence number assigned by
  // SQLite's AUTOINCREMENT — it deliberately ignores `event.seq` (which is
  // only a *process-local* counter on the in-memory EventBus, reset to 1 on
  // every new process). Using the bus-local value as the primary key would
  // collide the moment a second process (a second run, or `resume` after a
  // crash) appended its own event #1.
  appendEvent(event: Omit<BaseEvent, "seq">): number {
    const result = this.db
      .prepare(
        `INSERT INTO events (run_id, task_id, type, timestamp, data_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.runId,
        event.taskId ?? null,
        event.type,
        event.timestamp,
        JSON.stringify(event.data),
      );
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string, sinceSeq = 0): BaseEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(runId, sinceSeq) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: r.seq as number,
      runId: r.run_id as string,
      taskId: (r.task_id as string | null) ?? undefined,
      type: r.type as BaseEvent["type"],
      timestamp: r.timestamp as string,
      data: JSON.parse(r.data_json as string),
    }));
  }

  // ---- approvals -----------------------------------------------------
  createApproval(
    approval: Omit<ApprovalRecord, "id" | "requestedAt" | "status">,
  ): ApprovalRecord {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, task_id, scope, status, summary, requested_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        approval.runId,
        approval.taskId ?? null,
        approval.scope,
        approval.summary,
        ts,
      );
    return { ...approval, id, status: "pending", requestedAt: ts };
  }

  /**
   * Compare-and-set: only resolves the approval if it is still "pending".
   * Returns false if it was already resolved by someone else (double
   * approve/reject, or a race between two `agent-loop approve` processes),
   * so callers can report that instead of silently overwriting a decision.
   */
  resolveApproval(
    id: string,
    status: "approved" | "rejected",
    decidedBy?: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(status, now(), decidedBy ?? "user", id);
    return Number(result.changes) > 0;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  /**
   * Most recent approval matching this exact (runId, taskId, scope, summary)
   * tuple, in ANY status. Used to make approval resolution durable across a
   * crash/resume: if the same request was already approved/rejected before
   * the process died, a resume must observe that decision instead of
   * creating a brand-new pending approval that nobody will ever resolve.
   * Matching on the literal summary (not just scope/taskId) is deliberate —
   * it's what keeps a resolved approval from one command being silently
   * reused for a *different* command against the same task later.
   */
  findApproval(
    runId: string,
    taskId: string | undefined,
    scope: string,
    summary: string,
  ): ApprovalRecord | undefined {
    const row = taskId
      ? (this.db
          .prepare(
            `SELECT * FROM approvals WHERE run_id = ? AND task_id = ? AND scope = ? AND summary = ? ORDER BY requested_at DESC LIMIT 1`,
          )
          .get(runId, taskId, scope, summary) as
          Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM approvals WHERE run_id = ? AND task_id IS NULL AND scope = ? AND summary = ? ORDER BY requested_at DESC LIMIT 1`,
          )
          .get(runId, scope, summary) as Record<string, unknown> | undefined);
    return row ? rowToApproval(row) : undefined;
  }

  getPendingApproval(
    runId: string,
    taskId?: string,
  ): ApprovalRecord | undefined {
    const row = taskId
      ? (this.db
          .prepare(
            `SELECT * FROM approvals WHERE run_id = ? AND task_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`,
          )
          .get(runId, taskId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`,
          )
          .get(runId) as Record<string, unknown> | undefined);
    return row ? rowToApproval(row) : undefined;
  }

  listApprovals(runId: string): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at ASC`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map(rowToApproval);
  }

  // ---- retries -------------------------------------------------------
  recordRetry(record: Omit<RetryRecord, "id" | "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO retries (id, run_id, task_id, attempt, error, backoff_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        record.runId,
        record.taskId,
        record.attempt,
        record.error ?? null,
        record.backoffMs,
        now(),
      );
  }

  // ---- conversations ---------------------------------------------------
  createConversation(
    runId: string,
    role: ConversationRecord["role"],
  ): ConversationRecord {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO conversations (id, run_id, role, token_count, created_at) VALUES (?, ?, ?, 0, ?)`,
      )
      .run(id, runId, role, ts);
    return { id, runId, role, tokenCount: 0, createdAt: ts };
  }

  updateConversationTokens(id: string, tokenCount: number): void {
    this.db
      .prepare(`UPDATE conversations SET token_count = ? WHERE id = ?`)
      .run(tokenCount, id);
  }

  compactConversation(
    oldId: string,
    summary: ConversationRecord["summary"],
  ): ConversationRecord {
    const newConv = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(oldId) as Record<string, unknown> | undefined;
    if (!newConv) throw new Error(`conversation ${oldId} not found`);
    const replacement = this.createConversation(
      newConv.run_id as string,
      newConv.role as ConversationRecord["role"],
    );
    this.db
      .prepare(
        `UPDATE conversations SET summary_json = ?, superseded_by = ? WHERE id = ?`,
      )
      .run(JSON.stringify(redactDeep(summary)), replacement.id, oldId);
    return replacement;
  }

  // ---- checkpoints -----------------------------------------------------
  createCheckpoint(
    checkpoint: Omit<CheckpointRecord, "id" | "createdAt">,
  ): CheckpointRecord {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, run_id, task_id, description, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        checkpoint.runId,
        checkpoint.taskId ?? null,
        checkpoint.description,
        checkpoint.ref ?? null,
        ts,
      );
    return { ...checkpoint, id, createdAt: ts };
  }

  listCheckpoints(runId: string): CheckpointRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at ASC`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      runId: r.run_id as string,
      taskId: (r.task_id as string | null) ?? undefined,
      description: r.description as string,
      ref: (r.ref as string | null) ?? undefined,
      createdAt: r.created_at as string,
    }));
  }

  // ---- idempotency -----------------------------------------------------
  //
  // Guarantee: a side-effecting action (write_file / run_command) that
  // previously reached "completed" for a given key is never re-executed —
  // its cached result is returned instead. An action that only reached
  // "attempted" (process crashed mid-execution, outcome on the real world
  // is unknown) is NOT silently retried when it carries "destructive" or
  // "network" risk: `getIdempotencyState` surfaces that ambiguity so the
  // caller can require a fresh approval instead of guessing. "read_only"
  // and "low" risk actions are safe to just re-run.
  //
  // A third terminal state, "failed", covers a *known* outcome that did not
  // succeed (unexpected exit code, signal, timeout, spawn failure): unlike
  // "attempted", the caller already knows exactly what happened, so it is
  // never confused for an unknown-outcome crash and never requires the
  // forced-approval retry path — it's just safe to run again like a fresh
  // action. `status` has no CHECK constraint in the schema (plain TEXT), so
  // adding this value requires no migration; existing "attempted"/
  // "completed" rows from before this value existed remain valid as-is.

  getIdempotencyState(
    key: string,
  ):
    | {
        status: "attempted" | "completed" | "failed";
        risk: string;
        result: unknown;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT status, risk, result_json FROM idempotency_keys WHERE key = ?`,
      )
      .get(key) as
      | {
          status: string;
          risk: string;
          result_json: string | null;
        }
      | undefined;
    if (!row) return undefined;

    // Defensive parsing, not just a type cast: `status` has no CHECK
    // constraint (by design, see above), and `result_json` is arbitrary
    // stored text. An unrecognized status, or a "completed" row whose
    // result_json is missing/empty/malformed, must never be silently
    // trusted as a verified success — that would let a corrupted or
    // half-written row masquerade as a cached success and skip execution
    // entirely (Executor.checkCache would return a fabricated fallback
    // result instead of ever running the command). Both fall back to
    // "attempted", reusing the existing crash-safe path (forced approval
    // before blindly retrying a destructive/network-risk action) instead
    // of throwing or guessing.
    let result: unknown;
    // "completed" is only ever trustworthy when result_json is present,
    // parses successfully, *and* parses to a non-null, non-array object —
    // NULL/absent, "", unparsable text, a stored `"null"`, and any bare
    // scalar or array (`false`, `0`, `"text"`, `[]`, ...) are all treated
    // the same: no usable result. Every real success Executor persists is
    // a plain object (write_file stores `{path}`, run_command stores a
    // CommandResult object) — never a bare scalar/array — so anything else
    // can only be a corrupted/half-written/tampered row. "failed" rows
    // don't need this guarantee (their result_json is diagnostic-only;
    // checkCache never reads it to decide whether to skip execution).
    let resultUsable = false;
    if (row.result_json) {
      try {
        const parsed = JSON.parse(row.result_json) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          result = parsed;
          resultUsable = true;
        }
      } catch {
        resultUsable = false;
      }
    }
    const knownStatus =
      row.status === "completed" || row.status === "failed";
    const status: "attempted" | "completed" | "failed" =
      knownStatus && !(row.status === "completed" && !resultUsable)
        ? (row.status as "completed" | "failed")
        : "attempted";

    return { status, risk: row.risk, result };
  }

  /** Record that execution of this key has started, before it runs. */
  recordIdempotentAttempt(
    key: string,
    runId: string,
    taskId: string,
    risk: string,
  ): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'attempted', NULL, COALESCE((SELECT created_at FROM idempotency_keys WHERE key = ?), ?), ?)`,
      )
      .run(key, runId, taskId, risk, key, ts, ts);
  }

  /** Record the confirmed result once execution completes successfully. */
  recordIdempotentResult(
    key: string,
    runId: string,
    taskId: string,
    risk: string,
    result: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'completed', ?, COALESCE((SELECT created_at FROM idempotency_keys WHERE key = ?), ?), ?)`,
      )
      .run(
        key,
        runId,
        taskId,
        risk,
        JSON.stringify(redactDeep(result)),
        key,
        now(),
        now(),
      );
  }

  /**
   * Record a *known* terminal failure (not a crash): the command actually
   * ran and finished (or definitively failed to spawn/timed out/was
   * signaled), so the outcome is certain. Distinguished from "attempted" so
   * a retry never treats this as an unknown-outcome crash requiring forced
   * approval, and never returns it as a cached success. `failure` should be
   * a bounded, redacted diagnostic (see `CommandFailureError`); it is
   * redacted again here defensively before being persisted.
   */
  recordIdempotentFailure(
    key: string,
    runId: string,
    taskId: string,
    risk: string,
    failure: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_keys (key, run_id, task_id, risk, status, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'failed', ?, COALESCE((SELECT created_at FROM idempotency_keys WHERE key = ?), ?), ?)`,
      )
      .run(
        key,
        runId,
        taskId,
        risk,
        JSON.stringify(redactDeep(failure)),
        key,
        now(),
        now(),
      );
  }

  // ---- run locks ---------------------------------------------------------
  //
  // Prevents two `agent-loop run`/`resume` processes from driving the same
  // run concurrently, which would otherwise race on task/approval state.
  // A dead holder's lock is reclaimed automatically (best-effort liveness
  // check via `process.kill(pid, 0)`).

  tryAcquireRunLock(runId: string, holder: string, pid: number): boolean {
    const ts = now();
    const existing = this.db
      .prepare(`SELECT holder, pid FROM run_locks WHERE run_id = ?`)
      .get(runId) as { holder: string; pid: number } | undefined;
    // Blocked only by a *different* holder whose process is still alive.
    // Comparing by holder (not just pid) also blocks two concurrent calls
    // from the same OS process/pid racing on the same run — each call gets
    // a unique holder id, so same-pid-different-call still conflicts.
    if (
      existing &&
      existing.holder !== holder &&
      isProcessAlive(existing.pid)
    ) {
      return false;
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_locks (run_id, holder, pid, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, holder, pid, ts, ts);
    return true;
  }

  releaseRunLock(runId: string, holder: string): void {
    this.db
      .prepare(`DELETE FROM run_locks WHERE run_id = ? AND holder = ?`)
      .run(runId, holder);
  }

  /** For tests/diagnostics: current lock holder, if any. */
  getRunLock(
    runId: string,
  ): { holder: string; pid: number; acquiredAt: string } | undefined {
    const row = this.db
      .prepare(`SELECT * FROM run_locks WHERE run_id = ?`)
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      holder: row.holder as string,
      pid: row.pid as number,
      acquiredAt: row.acquired_at as string,
    };
  }

  // ---- memory ------------------------------------------------------------
  addMemory(record: Omit<MemoryRecord, "id" | "createdAt">): MemoryRecord {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO memory (id, run_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, record.runId ?? null, record.kind, record.content, ts);
    return { ...record, id, createdAt: ts };
  }

  listMemory(runId?: string): MemoryRecord[] {
    const rows = runId
      ? (this.db
          .prepare(
            `SELECT * FROM memory WHERE run_id = ? OR run_id IS NULL ORDER BY created_at ASC`,
          )
          .all(runId) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM memory ORDER BY created_at ASC`)
          .all() as Record<string, unknown>[]);
    return rows.map((r) => ({
      id: r.id as string,
      runId: (r.run_id as string | null) ?? undefined,
      kind: r.kind as MemoryRecord["kind"],
      content: r.content as string,
      createdAt: r.created_at as string,
    }));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rowToRun(row: Record<string, unknown>): Run {
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    workspace: row.workspace as string,
    status: row.status as RunStatus,
    currentConversationId:
      (row.current_conversation_id as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    description: row.description as string,
    dependencies: JSON.parse(row.dependencies_json as string),
    scope: (row.scope as string | null) ?? undefined,
    risk: row.risk as Task["risk"],
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json as string),
    status: row.status as TaskStatus,
    retryCount: row.retry_count as number,
    idempotencyKey: (row.idempotency_key as string | null) ?? undefined,
    result: row.result_json ? JSON.parse(row.result_json as string) : undefined,
    error: (row.error as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    taskId: (row.task_id as string | null) ?? undefined,
    scope: row.scope as ApprovalRecord["scope"],
    status: row.status as ApprovalRecord["status"],
    summary: row.summary as string,
    requestedAt: row.requested_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? undefined,
    decidedBy: (row.decided_by as string | null) ?? undefined,
  };
}

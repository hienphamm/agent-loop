import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EventBus } from "../events/bus.js";
import type { Repository } from "../persistence/repository.js";
import { classifyCommand, type CommandRisk } from "./commandSafety.js";
import { assertWorkspaceRootValid, resolveWorkspacePath } from "./workspace.js";
import type { ApprovalGate } from "./approval.js";
import {
  ActionValidationError,
  CommandFailureError,
  WorkspaceSafetyError,
  type CommandFailureReason,
} from "../errors/index.js";
import { sanitizedChildEnv } from "../util/childEnv.js";

export interface CommandResult {
  exitCode: number | null;
  /** Non-null when the process was terminated by a signal rather than exiting normally. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  /** True when the soft timeout fired and the process was killed for running too long. */
  timedOut?: boolean;
}

/** Default `expectedExitCodes` for a `run_command` action when the caller omits it: only a clean exit(0) counts as success. */
export const DEFAULT_EXPECTED_EXIT_CODES: readonly number[] = [0];

/** Valid POSIX/Node child-process exit code range. */
const MIN_EXIT_CODE = 0;
const MAX_EXIT_CODE = 255;

/**
 * Validates and normalizes a `run_command` action's `expectedExitCodes`.
 * - `undefined` -> defaults to `[0]` (the safe default: only a clean exit succeeds).
 * - Must be a non-empty array of integers in `[0, 255]` when provided explicitly
 *   (an empty array would accept nothing, which is almost certainly not what
 *   was intended, so it is rejected rather than silently accepting nothing —
 *   or, worse, being misread as "accept anything").
 * - Duplicates are normalized away (deduped + sorted) rather than rejected.
 *
 * Throws {@link ActionValidationError} — a non-retryable, actionable error —
 * on anything else, so a malformed action fails fast instead of running the
 * command and only failing (or worse, "succeeding") afterward.
 */
export function normalizeExpectedExitCodes(
  codes: ReadonlyArray<unknown> | undefined,
): number[] {
  if (codes === undefined) return [...DEFAULT_EXPECTED_EXIT_CODES];
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new ActionValidationError(
      "expectedExitCodes must be a non-empty array of integers when provided",
      'Omit expectedExitCodes to use the default [0], or provide at least one exit code, e.g. "expectedExitCodes": [0, 1].',
    );
  }
  const seen = new Set<number>();
  for (const raw of codes) {
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < MIN_EXIT_CODE ||
      raw > MAX_EXIT_CODE
    ) {
      throw new ActionValidationError(
        `expectedExitCodes must contain integers in the range ${MIN_EXIT_CODE}-${MAX_EXIT_CODE}; got ${JSON.stringify(raw)}`,
        'Use a real process exit code, e.g. "expectedExitCodes": [0, 1].',
      );
    }
    seen.add(raw);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Classifies a finished command's outcome against its accepted exit codes. */
function classifyOutcome(
  result: CommandResult,
  expectedExitCodes: number[],
): { success: true } | { success: false; reason: CommandFailureReason } {
  if (result.timedOut) return { success: false, reason: "COMMAND_TIMEOUT" };
  if (result.signal)
    return { success: false, reason: "TERMINATED_BY_SIGNAL" };
  if (result.exitCode !== null && expectedExitCodes.includes(result.exitCode))
    return { success: true };
  return { success: false, reason: "UNEXPECTED_EXIT_CODE" };
}

/**
 * The idempotency identity for a `run_command` action must include its
 * normalized `expectedExitCodes`: the exact same command can be an accepted
 * success under one policy (`[0, 1]`) and a failure under another (`[0]`),
 * so a cached result from one policy must never answer for the other.
 * `normalizedExpectedExitCodes` is expected already-normalized (deduped +
 * sorted), so equivalent inputs like `[1, 0, 1]` and `[0, 1]` hash identically.
 */
function hashRunCommandKey(
  runId: string,
  taskId: string,
  command: string,
  cwd: string | undefined,
  normalizedExpectedExitCodes: number[],
): string {
  return hashKey(
    "run_command",
    runId,
    taskId,
    command,
    cwd ?? "",
    JSON.stringify(normalizedExpectedExitCodes),
  );
}

/**
 * Computes the same idempotency identity `Executor.runCommand` uses for a
 * given (task, command, cwd, expectedExitCodes) tuple. Exposed only from
 * this module (not re-exported from the package root) for tests/tooling
 * that need to inspect a persisted idempotency row directly — it is not
 * part of the supported public API.
 */
export function computeRunCommandIdempotencyKey(
  runId: string,
  taskId: string,
  command: string,
  cwd: string | undefined,
  expectedExitCodes?: number[],
): string {
  return hashRunCommandKey(
    runId,
    taskId,
    command,
    cwd,
    normalizeExpectedExitCodes(expectedExitCodes),
  );
}

function hashWriteFileKey(
  runId: string,
  taskId: string,
  relPath: string,
  content: string,
): string {
  return hashKey("write_file", runId, taskId, relPath, content);
}

/**
 * Computes the same idempotency identity `Executor.writeFile` uses for a
 * given (task, path, content) tuple. Exposed only from this module (not
 * re-exported from the package root) for tests/tooling that need to inspect
 * a persisted idempotency row directly — it is not part of the supported
 * public API.
 */
export function computeWriteFileIdempotencyKey(
  runId: string,
  taskId: string,
  relPath: string,
  content: string,
): string {
  return hashWriteFileKey(runId, taskId, relPath, content);
}

/**
 * Bounded, redacted, structured diagnostic persisted for a known command
 * failure. Built from a {@link CommandFailureError}, whose own fields are
 * already bounded/redacted, so this is a plain field-by-field projection
 * (the repository layer redacts once more, defensively, before writing it).
 */
function failureDiagnostic(error: CommandFailureError): Record<string, unknown> {
  return {
    code: error.code,
    actualExitCode: error.actualExitCode,
    expectedExitCodes: error.expectedExitCodes,
    signal: error.signal,
    timedOut: error.timedOut,
    stdoutTail: error.stdoutTail ?? null,
    stderrTail: error.stderrTail ?? null,
  };
}

export interface ExecutorOptions {
  dryRun?: boolean;
  /** Soft timeout: SIGTERM is sent after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Grace period after SIGTERM before escalating to SIGKILL. Default 5s. */
  killGraceMs?: number;
  /** Max combined stdout+stderr bytes kept before truncating and killing. Default 5MB. */
  maxOutputBytes?: number;
}

/** Risk categories where a crashed/unknown-outcome attempt must not be silently retried. */
const UNSAFE_TO_BLINDLY_RETRY: ReadonlySet<CommandRisk> = new Set([
  "destructive",
  "network",
]);

/**
 * The only component allowed to touch the filesystem or spawn processes on
 * behalf of the Developer/Executor role. Every action is confined to the
 * workspace root, classified for risk, and gated by approval before running.
 *
 * Enforcement boundary, precisely: this class validates and confines the
 * *paths it is directly told to touch* (file reads/writes, and the initial
 * `cwd` of a spawned command). It does NOT sandbox what an approved shell
 * command does once it starts — a command can still `cd` elsewhere, spawn
 * children, or reach the network. See commandSafety.ts for what that means.
 */
export class Executor {
  private readonly workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    private readonly runId: string,
    private readonly repository: Repository,
    private readonly events: EventBus,
    private readonly approvalGate: ApprovalGate,
    private readonly options: ExecutorOptions = {},
  ) {
    this.workspaceRoot = assertWorkspaceRootValid(workspaceRoot);
  }

  readFile(taskId: string, relPath: string): string {
    const abs = resolveWorkspacePath(this.assertWorkspaceStillValid(), relPath);
    return readFileSync(abs, "utf8");
  }

  async writeFile(
    taskId: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    // Validated once up front so path traversal fails fast even on a cache hit.
    resolveWorkspacePath(this.assertWorkspaceStillValid(), relPath);
    const idempotencyKey = hashWriteFileKey(
      this.runId,
      taskId,
      relPath,
      content,
    );

    const cached = this.checkCache(
      idempotencyKey,
      "write_file",
      relPath,
      taskId,
    );
    if (cached.skip) return;

    const approved = await this.approvalGate.requestApproval({
      runId: this.runId,
      taskId,
      scope: "task",
      summary: `write file ${relPath} (${content.length} bytes)`,
    });
    if (!approved) {
      throw new WorkspaceSafetyError(
        `Write to "${relPath}" was rejected by approval policy`,
      );
    }
    if (this.options.dryRun) {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "progress",
        data: { message: `[dry-run] would write ${relPath}` },
      });
      return;
    }

    this.repository.recordIdempotentAttempt(
      idempotencyKey,
      this.runId,
      taskId,
      "low",
    );
    // Re-validate immediately before the write: the workspace root or an
    // intermediate directory could have been replaced/relinked between the
    // check above and now (best-effort TOCTOU defense — see workspace.ts).
    const abs = resolveWorkspacePath(this.assertWorkspaceStillValid(), relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    this.repository.recordIdempotentResult(
      idempotencyKey,
      this.runId,
      taskId,
      "low",
      { path: relPath },
    );
  }

  /**
   * Runs a shell command. By default only a clean `exit 0` counts as
   * success — pass `expectedExitCodes` to accept other codes intentionally
   * (e.g. `[0, 1]` for a linter that uses 1 to mean "found issues"). Any
   * outcome outside that set — an unexpected exit code, termination by
   * signal, a timeout, a spawn failure, or rejection by approval policy —
   * throws a {@link CommandFailureError} instead of returning a result, so a
   * failed command can never be silently treated as a completed task.
   */
  async runCommand(
    taskId: string,
    command: string,
    cwd?: string,
    expectedExitCodes?: number[],
  ): Promise<CommandResult> {
    const normalizedExpectedExitCodes = normalizeExpectedExitCodes(
      expectedExitCodes,
    );
    const root = this.assertWorkspaceStillValid();
    const workingDir = cwd ? resolveWorkspacePath(root, cwd) : root;
    const classification = classifyCommand(command);

    const idempotencyKey = hashRunCommandKey(
      this.runId,
      taskId,
      command,
      cwd,
      normalizedExpectedExitCodes,
    );
    const cached = this.checkCache(
      idempotencyKey,
      "run_command",
      command,
      taskId,
      classification.risk,
    );
    if (cached.skip)
      return (
        (cached.result as CommandResult) ?? {
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
        }
      );
    if (cached.requiresApprovalBeforeRetry) {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "progress",
        data: {
          message: `previous attempt of "${command}" crashed before its outcome was recorded (risk=${classification.risk}); requiring approval before retrying instead of silently re-running it`,
        },
      });
    }

    const approved = await this.approvalGate.requestApproval({
      runId: this.runId,
      taskId,
      scope: "task",
      summary: cached.requiresApprovalBeforeRetry
        ? `RETRY (outcome of previous attempt unknown): ${command}`
        : `run: ${command}`,
      classification,
      forceManual: cached.requiresApprovalBeforeRetry,
    });
    if (!approved) {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "command_completed",
        data: {
          command,
          exitCode: null,
          signal: null,
          success: false,
          failureReason: "APPROVAL_REJECTED",
          expectedExitCodes: normalizedExpectedExitCodes,
        },
      });
      throw new CommandFailureError({
        reason: "APPROVAL_REJECTED",
        command,
        actualExitCode: null,
        expectedExitCodes: normalizedExpectedExitCodes,
        signal: null,
        timedOut: false,
        runId: this.runId,
        taskId,
      });
    }

    this.events.emit({
      runId: this.runId,
      taskId,
      type: "command_started",
      data: { command, risk: classification.risk },
    });

    if (this.options.dryRun) {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "command_completed",
        data: { command, exitCode: 0, success: true, dryRun: true },
      });
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    }

    this.repository.recordIdempotentAttempt(
      idempotencyKey,
      this.runId,
      taskId,
      classification.risk,
    );

    let result: CommandResult;
    try {
      result = await this.spawnShell(command, workingDir);
    } catch (error) {
      const spawnMessage = (error as Error).message;
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "command_completed",
        data: {
          command,
          exitCode: null,
          signal: null,
          success: false,
          failureReason: "COMMAND_SPAWN_FAILED",
          expectedExitCodes: normalizedExpectedExitCodes,
        },
      });
      const failureError = new CommandFailureError(
        {
          reason: "COMMAND_SPAWN_FAILED",
          command,
          actualExitCode: null,
          expectedExitCodes: normalizedExpectedExitCodes,
          signal: null,
          timedOut: false,
          runId: this.runId,
          taskId,
        },
        spawnMessage,
      );
      // A spawn failure is a *known* outcome (the OS told us exactly why),
      // not a crash of this process — persist it distinctly so a retry
      // re-runs it plainly instead of being treated as an unknown-outcome
      // crash that forces a fresh approval.
      this.repository.recordIdempotentFailure(
        idempotencyKey,
        this.runId,
        taskId,
        classification.risk,
        failureDiagnostic(failureError),
      );
      throw failureError;
    }

    const outcome = classifyOutcome(result, normalizedExpectedExitCodes);
    this.events.emit({
      runId: this.runId,
      taskId,
      type: "command_completed",
      data: {
        command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut ?? false,
        truncated: result.truncated ?? false,
        expectedExitCodes: normalizedExpectedExitCodes,
        success: outcome.success,
        ...(outcome.success ? {} : { failureReason: outcome.reason }),
      },
    });

    if (!outcome.success) {
      const failureError = new CommandFailureError({
        reason: outcome.reason,
        command,
        actualExitCode: result.exitCode,
        expectedExitCodes: normalizedExpectedExitCodes,
        signal: result.signal,
        timedOut: result.timedOut ?? false,
        runId: this.runId,
        taskId,
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      });
      this.repository.recordIdempotentFailure(
        idempotencyKey,
        this.runId,
        taskId,
        classification.risk,
        failureDiagnostic(failureError),
      );
      throw failureError;
    }

    this.repository.recordIdempotentResult(
      idempotencyKey,
      this.runId,
      taskId,
      classification.risk,
      result,
    );
    return result;
  }

  createCheckpoint(taskId: string | undefined, description: string): void {
    this.repository.createCheckpoint({
      runId: this.runId,
      taskId,
      description,
    });
  }

  /** Re-checks the workspace root exists and hasn't been swapped since construction. */
  private assertWorkspaceStillValid(): string {
    return assertWorkspaceRootValid(this.workspaceRoot);
  }

  private checkCache(
    key: string,
    kind: "write_file" | "run_command",
    subject: string,
    taskId: string,
    risk: CommandRisk = "low",
  ): {
    skip: boolean;
    result?: unknown;
    requiresApprovalBeforeRetry?: boolean;
  } {
    const state = this.repository.getIdempotencyState(key);
    if (!state) return { skip: false };

    if (state.status === "completed") {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "progress",
        data: {
          message: `skip (already applied): ${kind === "write_file" ? `write ${subject}` : subject}`,
        },
      });
      return { skip: true, result: state.result };
    }

    // status === "failed": a previous attempt ran to a *known* conclusion
    // that didn't succeed (unexpected exit code, signal, timeout, spawn
    // failure) — the outcome is certain, so it's neither cached as success
    // nor treated as an unknown-outcome crash. Just let it run again like a
    // fresh action; the normal retry policy decides whether to keep trying.
    if (state.status === "failed") {
      return { skip: false };
    }

    // status === "attempted": a previous run started this and we never
    // learned the outcome (crash, kill -9, power loss). Re-running a
    // read-only/low-risk action is safe; re-running something classified
    // destructive/network could double-charge, double-post, or double-delete.
    if (UNSAFE_TO_BLINDLY_RETRY.has(risk)) {
      return { skip: false, requiresApprovalBeforeRetry: true };
    }
    return { skip: false };
  }

  private spawnShell(command: string, cwd: string): Promise<CommandResult> {
    const maxOutputBytes = this.options.maxOutputBytes ?? 5 * 1024 * 1024;
    const softTimeoutMs = this.options.timeoutMs ?? 10 * 60 * 1000;
    const killGraceMs = this.options.killGraceMs ?? 5000;

    return new Promise((resolve, reject) => {
      // shell: true is required so multi-command shell syntax (pipes,
      // redirects, &&) the Developer/Executor emits actually works; see
      // commandSafety.ts for what that trades away, and workspace.ts /
      // approval.ts for what still bounds it (approved paths, cwd, risk
      // gating). Secrets are stripped from the child's environment below.
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedChildEnv(),
      });

      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let hardKillTimer: NodeJS.Timeout | undefined;
      const softTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      }, softTimeoutMs);

      const appendCapped = (target: "stdout" | "stderr", chunk: Buffer) => {
        if (outputBytes >= maxOutputBytes) {
          if (!truncated) truncated = true;
          return;
        }
        const remaining = maxOutputBytes - outputBytes;
        const text = chunk.toString("utf8");
        const slice =
          Buffer.byteLength(text) > remaining
            ? chunk.subarray(0, remaining).toString("utf8")
            : text;
        outputBytes += Buffer.byteLength(slice);
        if (target === "stdout") stdout += slice;
        else stderr += slice;
        if (outputBytes >= maxOutputBytes) {
          truncated = true;
          // Output cap reached: stop the process rather than let it run
          // unbounded while we silently drop everything after this point.
          child.kill("SIGTERM");
          hardKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) =>
        appendCapped("stdout", chunk),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        appendCapped("stderr", chunk),
      );
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        reject(error);
      });
      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        resolve({ exitCode, signal, stdout, stderr, truncated, timedOut });
      });
    });
  }
}

/**
 * Hashes an ordered tuple of fields into a single idempotency identity.
 *
 * Encoded via `JSON.stringify(parts)` rather than `parts.join(" ")`:
 * joining with a plain separator loses field boundaries, so distinct
 * tuples can collide whenever a separator character appears inside a
 * field — e.g. `["exit 0", "a b"]` and `["exit 0 a", "b"]` both join to
 * `"exit 0 a b"`. JSON-encoding each element (with its own quoting/
 * escaping) makes the boundary between fields unambiguous, so only
 * genuinely identical tuples can hash the same.
 *
 * This is the second time the encoding has changed (the first added
 * `expectedExitCodes` as an extra field); each change makes idempotency
 * rows written under the old encoding unreachable under the new one — they
 * are simply orphaned (a fresh run treats the action as never-seen and
 * executes it normally), never misread as a stale success. No migration is
 * needed since `idempotency_keys.key` has no format constraint, only a
 * PRIMARY KEY uniqueness constraint on whatever string is stored.
 */
function hashKey(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

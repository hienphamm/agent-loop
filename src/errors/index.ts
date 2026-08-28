import { redact } from "../auth/redact.js";

/**
 * Structured error hierarchy used across the whole package.
 * Every error carries a stable `code` and an actionable `hint` so the CLI
 * can print something a user can act on instead of a raw stack trace.
 */
export class AgentLoopError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly cause2: unknown;

  constructor(
    code: string,
    message: string,
    options?: { hint?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "AgentLoopError";
    this.code = code;
    this.hint = options?.hint;
    this.cause2 = options?.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.hint ?? null,
    };
  }
}

export class ConfigError extends AgentLoopError {
  constructor(message: string, hint?: string) {
    super("CONFIG_INVALID", message, { hint });
    this.name = "ConfigError";
  }
}

export class AuthError extends AgentLoopError {
  constructor(message: string, hint?: string) {
    super("AUTH_FAILED", message, { hint });
    this.name = "AuthError";
  }
}

export class WorkspaceSafetyError extends AgentLoopError {
  constructor(message: string, hint?: string) {
    super("WORKSPACE_VIOLATION", message, { hint });
    this.name = "WorkspaceSafetyError";
  }
}

export class ApprovalRequiredError extends AgentLoopError {
  constructor(message: string, hint?: string) {
    super("APPROVAL_REQUIRED", message, { hint });
    this.name = "ApprovalRequiredError";
  }
}

export class RunNotFoundError extends AgentLoopError {
  constructor(runId: string) {
    super("RUN_NOT_FOUND", `No run found with id "${runId}"`, {
      hint: "Use `agent-loop status` without an id to see recent runs, or check the id for typos.",
    });
    this.name = "RunNotFoundError";
  }
}

export class ProviderError extends AgentLoopError {
  /** Whether retrying this exact call could plausibly succeed (timeouts, 429, 5xx) vs. not (4xx auth/bad request, malformed-output-repeatedly). */
  readonly retryable: boolean;

  constructor(message: string, hint?: string, retryable = true) {
    super("PROVIDER_ERROR", message, { hint });
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

/**
 * Stable, machine-readable sub-codes for {@link ActionValidationError},
 * distinguishing *why* an action was rejected without callers needing to
 * parse `message`. The top-level `code` stays `"INVALID_ACTION"` for
 * backward compatibility; `validationCode` narrows it further.
 */
export type ActionValidationCode =
  | "UNKNOWN_ACTION_TYPE"
  | "UNKNOWN_FIELD"
  | "MALFORMED_ACTION"
  | "MISSING_FIELD"
  | "INVALID_FIELD";

/**
 * A `run_command`/other developer-agent action referenced a malformed or
 * unsafe property (e.g. an invalid `expectedExitCodes`), an unknown action
 * type, or an unrecognized field. Raised before the action is ever executed
 * (before filesystem mutation, approval, or process spawn), so retrying
 * without changing the action can't help.
 */
export class ActionValidationError extends AgentLoopError {
  readonly validationCode: ActionValidationCode;
  readonly details?: readonly string[];

  constructor(
    message: string,
    hint?: string,
    options?: {
      validationCode?: ActionValidationCode;
      details?: readonly string[];
    },
  ) {
    super("INVALID_ACTION", message, { hint });
    this.name = "ActionValidationError";
    this.validationCode = options?.validationCode ?? "MALFORMED_ACTION";
    this.details = options?.details;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      validationCode: this.validationCode,
      details: this.details ?? null,
    };
  }
}

/**
 * Stable, machine-readable reasons a `run_command` action did not succeed.
 * Never collapsed into a single string-only error: each maps to distinct
 * structured fields on {@link CommandFailureError} (actualExitCode, signal,
 * timedOut, ...) so callers can branch on `code`/`reason` instead of parsing
 * the human-readable `message`.
 */
export type CommandFailureReason =
  | "UNEXPECTED_EXIT_CODE"
  | "TERMINATED_BY_SIGNAL"
  | "COMMAND_TIMEOUT"
  | "COMMAND_SPAWN_FAILED"
  | "APPROVAL_REJECTED";

export interface CommandFailureDetails {
  reason: CommandFailureReason;
  command: string;
  actualExitCode: number | null;
  expectedExitCodes: number[];
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /**
   * True when the process was killed for exceeding the output byte cap.
   * This is independent of `reason`: hitting the output limit kills the
   * process via `SIGTERM`/`SIGKILL` just like an external signal would, so
   * without this flag a self-imposed output-limit kill is indistinguishable
   * from `TERMINATED_BY_SIGNAL` caused by something else entirely (or, if
   * the process happens to exit on its own right as the limit is enforced,
   * from a plain `UNEXPECTED_EXIT_CODE`). Never true for `COMMAND_TIMEOUT`
   * or `COMMAND_SPAWN_FAILED`, whose own reason already fully explains what
   * happened.
   */
  truncated: boolean;
  runId: string;
  taskId: string;
  /** Bounded, unredacted tail of stdout — redacted internally before storage. */
  stdoutTail?: string;
  /** Bounded, unredacted tail of stderr — redacted internally before storage. */
  stderrTail?: string;
}

/** Bound on stdout/stderr kept in a CommandFailureError's diagnostic fields. */
const MAX_DIAGNOSTIC_CHARS = 2000;

/**
 * Redact first, *then* truncate — never the other way around. Truncating
 * before redacting can slice a registered secret in half at the truncation
 * boundary: `redact()` only matches a *complete* occurrence of a known
 * secret, so a truncated fragment (e.g. the last 10 characters of a 30-char
 * token) would not match and would leak verbatim in the bounded output.
 * Redacting the full text first replaces every complete occurrence with
 * `[REDACTED]` regardless of where it falls, so truncating afterward can
 * only ever cut through already-scrubbed placeholder text.
 */
function boundedRedacted(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const scrubbed = redact(text);
  return scrubbed.length > MAX_DIAGNOSTIC_CHARS
    ? scrubbed.slice(-MAX_DIAGNOSTIC_CHARS)
    : scrubbed;
}

function describeFailure(details: CommandFailureDetails): string {
  switch (details.reason) {
    case "UNEXPECTED_EXIT_CODE":
      return (
        `exited with code ${details.actualExitCode} (expected one of [${details.expectedExitCodes.join(", ")}])` +
        (details.truncated
          ? " — note: its output had already reached the configured limit before it exited"
          : "")
      );
    case "TERMINATED_BY_SIGNAL":
      return details.truncated
        ? `was terminated by signal ${details.signal} after its output reached the configured limit`
        : `was terminated by signal ${details.signal}`;
    case "COMMAND_TIMEOUT":
      return "timed out and was killed";
    case "COMMAND_SPAWN_FAILED":
      return "failed to spawn";
    case "APPROVAL_REJECTED":
      return "was rejected by approval policy";
    default: {
      const exhaustive: never = details.reason;
      return exhaustive;
    }
  }
}

/**
 * A `run_command` action did not succeed: its actual exit code (or
 * termination reason) was not one of the action's `expectedExitCodes`
 * (default `[0]`). Carries structured, machine-readable fields so callers
 * never have to parse `message` to find out what happened.
 */
export class CommandFailureError extends AgentLoopError {
  readonly reason: CommandFailureReason;
  readonly command: string;
  readonly actualExitCode: number | null;
  readonly expectedExitCodes: number[];
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly runId: string;
  readonly taskId: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;

  constructor(details: CommandFailureDetails, hint?: string) {
    const message = `command "${redact(details.command)}" ${describeFailure(details)} [task ${details.taskId}, run ${details.runId}]`;
    super(details.reason, message, { hint });
    this.name = "CommandFailureError";
    this.reason = details.reason;
    this.command = redact(details.command);
    this.actualExitCode = details.actualExitCode;
    this.expectedExitCodes = details.expectedExitCodes;
    this.signal = details.signal;
    this.timedOut = details.timedOut;
    this.truncated = details.truncated;
    this.runId = details.runId;
    this.taskId = details.taskId;
    this.stdoutTail = boundedRedacted(details.stdoutTail);
    this.stderrTail = boundedRedacted(details.stderrTail);
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      reason: this.reason,
      command: this.command,
      actualExitCode: this.actualExitCode,
      expectedExitCodes: this.expectedExitCodes,
      signal: this.signal,
      timedOut: this.timedOut,
      truncated: this.truncated,
      runId: this.runId,
      taskId: this.taskId,
      stdoutTail: this.stdoutTail ?? null,
      stderrTail: this.stderrTail ?? null,
    };
  }
}

/**
 * Converts any thrown value into a displayable shape, redacting secrets on
 * the way out. This is the *last* line of defense before an error message
 * reaches stdout/stderr/JSON output — every CLI error path must go through
 * this (or `redact()` directly) rather than printing `error.message` raw,
 * since an underlying library (fetch, child_process, etc.) could echo a
 * request that included a secret back into its own error text.
 */
export function toDisplayError(error: unknown): {
  code: string;
  message: string;
  hint?: string;
} {
  if (error instanceof AgentLoopError) {
    const result: { code: string; message: string; hint?: string } = {
      code: error.code,
      message: redact(error.message),
    };
    if (error.hint) result.hint = redact(error.hint);
    return result;
  }
  if (error instanceof Error) {
    return { code: "UNKNOWN_ERROR", message: redact(error.message) };
  }
  return { code: "UNKNOWN_ERROR", message: redact(String(error)) };
}

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

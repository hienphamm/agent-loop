export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export function backoffDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, policy.maxDelayMs);
}

/** Errors that are worth retrying. Config/safety errors are not — retrying them can't help. */
export function isRetryableError(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  if (
    name === "WorkspaceSafetyError" ||
    name === "ConfigError" ||
    name === "AuthError" ||
    name === "ActionValidationError"
  ) {
    return false;
  }
  if (name === "ProviderError") {
    // Explicit per-error classification (timeout/429/5xx vs. 4xx auth/bad request).
    return (error as { retryable?: boolean }).retryable !== false;
  }
  if (name === "CommandFailureError") {
    // APPROVAL_REJECTED is an explicit human/policy decision, not a
    // transient process failure — retrying can't change it and would just
    // re-prompt for the same rejected action. Every other reason
    // (UNEXPECTED_EXIT_CODE, TERMINATED_BY_SIGNAL, COMMAND_TIMEOUT,
    // COMMAND_SPAWN_FAILED) keeps the normal retry policy.
    return (error as { reason?: string }).reason !== "APPROVAL_REJECTED";
  }
  return true;
}

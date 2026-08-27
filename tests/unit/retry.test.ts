import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  isRetryableError,
  DEFAULT_RETRY_POLICY,
} from "../../src/orchestration/retry.js";
import {
  WorkspaceSafetyError,
  ProviderError,
  CommandFailureError,
} from "../../src/errors/index.js";
import type { CommandFailureReason } from "../../src/errors/index.js";

function commandFailure(reason: CommandFailureReason): CommandFailureError {
  return new CommandFailureError({
    reason,
    command: "x",
    actualExitCode: reason === "UNEXPECTED_EXIT_CODE" ? 1 : null,
    expectedExitCodes: [0],
    signal: reason === "TERMINATED_BY_SIGNAL" ? "SIGTERM" : null,
    timedOut: reason === "COMMAND_TIMEOUT",
    truncated: false,
    runId: "run-1",
    taskId: "t1",
  });
}

describe("backoffDelay", () => {
  it("doubles per attempt up to the max", () => {
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(10, DEFAULT_RETRY_POLICY)).toBe(
      DEFAULT_RETRY_POLICY.maxDelayMs,
    );
  });
});

describe("isRetryableError", () => {
  it("does not retry workspace safety violations", () => {
    expect(isRetryableError(new WorkspaceSafetyError("nope"))).toBe(false);
  });

  it("retries generic provider errors", () => {
    expect(isRetryableError(new ProviderError("timeout"))).toBe(true);
  });

  it("does not retry an explicit APPROVAL_REJECTED command failure", () => {
    expect(isRetryableError(commandFailure("APPROVAL_REJECTED"))).toBe(false);
  });

  it("retries every other CommandFailureReason (unexpected exit, signal, timeout, spawn failure)", () => {
    expect(isRetryableError(commandFailure("UNEXPECTED_EXIT_CODE"))).toBe(
      true,
    );
    expect(isRetryableError(commandFailure("TERMINATED_BY_SIGNAL"))).toBe(
      true,
    );
    expect(isRetryableError(commandFailure("COMMAND_TIMEOUT"))).toBe(true);
    expect(isRetryableError(commandFailure("COMMAND_SPAWN_FAILED"))).toBe(
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  isRetryableError,
  DEFAULT_RETRY_POLICY,
} from "../../src/orchestration/retry.js";
import { WorkspaceSafetyError, ProviderError } from "../../src/errors/index.js";

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
});

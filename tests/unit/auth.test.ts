import { describe, expect, it } from "vitest";
import { ApiKeyAuth } from "../../src/auth/apiKey.js";
import { CliSessionAuth } from "../../src/auth/cliSession.js";
import { createAuthAdapter } from "../../src/auth/factory.js";
import {
  redact,
  registerSecret,
  clearRegisteredSecrets,
} from "../../src/auth/redact.js";
import { AuthError } from "../../src/errors/index.js";

describe("ApiKeyAuth", () => {
  it("reports ok when a key is present", async () => {
    const auth = new ApiKeyAuth("reviewer", "sk-test-key-123456");
    const result = await auth.check();
    expect(result.ok).toBe(true);
  });

  it("reports failure with a remedy when no key is present", async () => {
    const auth = new ApiKeyAuth("reviewer", undefined);
    const result = await auth.check();
    expect(result.ok).toBe(false);
    expect(result.remedyCommand).toContain("AGENT_LOOP_REVIEWER_API_KEY");
  });
});

describe("CliSessionAuth", () => {
  it("reports ok when the check command exits 0", async () => {
    const auth = new CliSessionAuth("developer", "true", "some login command");
    const result = await auth.check();
    expect(result.ok).toBe(true);
  });

  it("reports failure with the login command when the check command fails", async () => {
    const auth = new CliSessionAuth("developer", "false", "codex login");
    const result = await auth.check();
    expect(result.ok).toBe(false);
    expect(result.remedyCommand).toBe("codex login");
  });
});

describe("createAuthAdapter", () => {
  it("never falls back from api_key to cli or vice versa", () => {
    expect(() =>
      createAuthAdapter("reviewer", {
        provider: "openai",
        model: "gpt",
        auth: "api_key",
      }),
    ).toThrow(AuthError);
  });
});

describe("redact", () => {
  it("scrubs registered secrets from arbitrary strings", () => {
    clearRegisteredSecrets();
    registerSecret("sk-super-secret-value");
    const output = redact(
      "the key is sk-super-secret-value and should not leak",
    );
    expect(output).not.toContain("sk-super-secret-value");
    expect(output).toContain("[REDACTED]");
  });

  it("scrubs key-shaped strings even when not pre-registered", () => {
    clearRegisteredSecrets();
    const output = redact("Authorization: Bearer abcdefghij1234567890");
    expect(output).not.toContain("abcdefghij1234567890");
  });
});

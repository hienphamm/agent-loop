import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/load.js";
import { ConfigError } from "../../src/errors/index.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-config-"));
}

describe("loadConfig", () => {
  it("loads values from .env and applies defaults", () => {
    const cwd = makeTmpDir();
    writeFileSync(
      path.join(cwd, ".env"),
      [
        "AGENT_LOOP_REVIEWER_PROVIDER=openai",
        "AGENT_LOOP_REVIEWER_MODEL=gpt-review",
        "AGENT_LOOP_REVIEWER_AUTH=api_key",
        "AGENT_LOOP_REVIEWER_API_KEY=abc123def",
        "AGENT_LOOP_DEVELOPER_PROVIDER=anthropic",
        "AGENT_LOOP_DEVELOPER_MODEL=claude",
        "AGENT_LOOP_DEVELOPER_AUTH=api_key",
        "AGENT_LOOP_DEVELOPER_API_KEY=xyz789ghi",
        "AGENT_LOOP_WORKSPACE=./ws",
      ].join("\n"),
    );
    const { config } = loadConfig({ cwd, env: {} });
    expect(config.reviewer.provider).toBe("openai");
    expect(config.developer.provider).toBe("anthropic");
    expect(config.approvalMode).toBe("manual");
    expect(config.workspace).toBe(path.resolve(cwd, "ws"));
  });

  it("lets CLI overrides win over .env values", () => {
    const cwd = makeTmpDir();
    const { config } = loadConfig({
      cwd,
      env: {
        AGENT_LOOP_APPROVAL_MODE: "manual",
        AGENT_LOOP_REVIEWER_PROVIDER: "openai",
        AGENT_LOOP_REVIEWER_MODEL: "gpt",
        AGENT_LOOP_REVIEWER_AUTH: "api_key",
        AGENT_LOOP_REVIEWER_API_KEY: "sk-reviewer-123456",
        AGENT_LOOP_DEVELOPER_PROVIDER: "anthropic",
        AGENT_LOOP_DEVELOPER_MODEL: "claude",
        AGENT_LOOP_DEVELOPER_AUTH: "api_key",
        AGENT_LOOP_DEVELOPER_API_KEY: "sk-developer-123456",
      },
      overrides: { approvalMode: "safe" },
    });
    expect(config.approvalMode).toBe("safe");
  });

  it("throws a ConfigError when api_key mode has no key", () => {
    const cwd = makeTmpDir();
    expect(() =>
      loadConfig({
        cwd,
        env: {
          AGENT_LOOP_REVIEWER_PROVIDER: "openai",
          AGENT_LOOP_REVIEWER_MODEL: "gpt",
          AGENT_LOOP_REVIEWER_AUTH: "api_key",
          AGENT_LOOP_DEVELOPER_PROVIDER: "openai",
          AGENT_LOOP_DEVELOPER_MODEL: "gpt",
          AGENT_LOOP_DEVELOPER_AUTH: "api_key",
          AGENT_LOOP_DEVELOPER_API_KEY: "xyz789ghi",
        },
      }),
    ).toThrow(ConfigError);
  });

  it("falls back to provider-specific env vars for the API key", () => {
    const cwd = makeTmpDir();
    const { config } = loadConfig({
      cwd,
      env: {
        AGENT_LOOP_REVIEWER_PROVIDER: "openai",
        AGENT_LOOP_REVIEWER_MODEL: "gpt",
        AGENT_LOOP_REVIEWER_AUTH: "api_key",
        OPENAI_API_KEY: "sk-fallback-key-123",
        AGENT_LOOP_DEVELOPER_PROVIDER: "anthropic",
        AGENT_LOOP_DEVELOPER_MODEL: "claude",
        AGENT_LOOP_DEVELOPER_AUTH: "api_key",
        ANTHROPIC_API_KEY: "anthropic-fallback-456",
      },
    });
    expect(config.reviewer.apiKey).toBe("sk-fallback-key-123");
    expect(config.developer.apiKey).toBe("anthropic-fallback-456");
  });

  it("does not silently fall back from cli to api_key auth", () => {
    const cwd = makeTmpDir();
    const { config, warnings } = loadConfig({
      cwd,
      env: {
        AGENT_LOOP_REVIEWER_PROVIDER: "openai",
        AGENT_LOOP_REVIEWER_MODEL: "gpt",
        AGENT_LOOP_REVIEWER_AUTH: "cli",
        AGENT_LOOP_DEVELOPER_PROVIDER: "anthropic",
        AGENT_LOOP_DEVELOPER_MODEL: "claude",
        AGENT_LOOP_DEVELOPER_AUTH: "api_key",
        AGENT_LOOP_DEVELOPER_API_KEY: "xyz789ghi",
      },
    });
    expect(config.reviewer.auth).toBe("cli");
    expect(config.reviewer.apiKey).toBeUndefined();
    expect(warnings.some((w) => w.code === "CLI_CHECK_COMMAND_MISSING")).toBe(
      true,
    );
  });

  it("leaves maxDeveloperActions/developerActionWallTimeMs undefined by default (DeveloperAgent applies its own conservative defaults)", () => {
    const cwd = makeTmpDir();
    const { config } = loadConfig({
      cwd,
      env: {
        AGENT_LOOP_REVIEWER_PROVIDER: "openai",
        AGENT_LOOP_REVIEWER_MODEL: "gpt",
        AGENT_LOOP_REVIEWER_AUTH: "api_key",
        AGENT_LOOP_REVIEWER_API_KEY: "sk-reviewer-123456",
        AGENT_LOOP_DEVELOPER_PROVIDER: "anthropic",
        AGENT_LOOP_DEVELOPER_MODEL: "claude",
        AGENT_LOOP_DEVELOPER_AUTH: "api_key",
        AGENT_LOOP_DEVELOPER_API_KEY: "sk-developer-123456",
      },
    });
    expect(config.maxDeveloperActions).toBeUndefined();
    expect(config.developerActionWallTimeMs).toBeUndefined();
  });

  it("reads maxDeveloperActions/developerActionWallTimeMs from the environment", () => {
    const cwd = makeTmpDir();
    const { config } = loadConfig({
      cwd,
      env: {
        AGENT_LOOP_REVIEWER_PROVIDER: "openai",
        AGENT_LOOP_REVIEWER_MODEL: "gpt",
        AGENT_LOOP_REVIEWER_AUTH: "api_key",
        AGENT_LOOP_REVIEWER_API_KEY: "sk-reviewer-123456",
        AGENT_LOOP_DEVELOPER_PROVIDER: "anthropic",
        AGENT_LOOP_DEVELOPER_MODEL: "claude",
        AGENT_LOOP_DEVELOPER_AUTH: "api_key",
        AGENT_LOOP_DEVELOPER_API_KEY: "sk-developer-123456",
        AGENT_LOOP_MAX_DEVELOPER_ACTIONS: "10",
        AGENT_LOOP_DEVELOPER_ACTION_WALL_TIME_MS: "5000",
      },
    });
    expect(config.maxDeveloperActions).toBe(10);
    expect(config.developerActionWallTimeMs).toBe(5000);
  });
});

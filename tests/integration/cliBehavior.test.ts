import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli", "main.ts");
const fakeProviderCli =
  "node " + path.join(repoRoot, "tests", "fixtures", "fakeProviderCli.mjs");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function scratchDirs() {
  const workspace = mkdtempSync(path.join(tmpdir(), "agent-loop-cli-ws-"));
  const stateDir = mkdtempSync(path.join(tmpdir(), "agent-loop-cli-state-"));
  return { workspace, stateDir };
}

const SECRET = "sk-should-never-appear-anywhere-1234567890";

describe("CLI behavior", () => {
  it("fails fast with an actionable error and exit code 1 on missing configuration", async () => {
    const { stateDir } = scratchDirs();
    const result = await runCli(["auth", "status"], {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_REVIEWER_PROVIDER: "",
      AGENT_LOOP_REVIEWER_MODEL: "",
      AGENT_LOOP_DEVELOPER_PROVIDER: "",
      AGENT_LOOP_DEVELOPER_MODEL: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid configuration");
    expect(result.stderr).not.toContain(SECRET);
  });

  it("auth status never prints the configured secret value", async () => {
    const { stateDir } = scratchDirs();
    const result = await runCli(["auth", "status"], {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_REVIEWER_PROVIDER: "openai",
      AGENT_LOOP_REVIEWER_MODEL: "gpt-test",
      AGENT_LOOP_REVIEWER_AUTH: "api_key",
      AGENT_LOOP_REVIEWER_API_KEY: SECRET,
      AGENT_LOOP_DEVELOPER_PROVIDER: "anthropic",
      AGENT_LOOP_DEVELOPER_MODEL: "claude-test",
      AGENT_LOOP_DEVELOPER_AUTH: "api_key",
      AGENT_LOOP_DEVELOPER_API_KEY: SECRET,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("apiKeyConfigured=true");
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
  });

  it("status with no runs prints a plain message and exits 0", async () => {
    const { stateDir } = scratchDirs();
    const result = await runCli(["status"], {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_REVIEWER_PROVIDER: "openai",
      AGENT_LOOP_REVIEWER_MODEL: "m",
      AGENT_LOOP_REVIEWER_AUTH: "api_key",
      AGENT_LOOP_REVIEWER_API_KEY: "x",
      AGENT_LOOP_DEVELOPER_PROVIDER: "openai",
      AGENT_LOOP_DEVELOPER_MODEL: "m",
      AGENT_LOOP_DEVELOPER_AUTH: "api_key",
      AGENT_LOOP_DEVELOPER_API_KEY: "x",
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("No runs yet.");
  });

  it("--json status output is machine-readable JSON with nothing else on stdout", async () => {
    const { stateDir } = scratchDirs();
    const result = await runCli(["status", "--json"], {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_REVIEWER_PROVIDER: "openai",
      AGENT_LOOP_REVIEWER_MODEL: "m",
      AGENT_LOOP_REVIEWER_AUTH: "api_key",
      AGENT_LOOP_REVIEWER_API_KEY: "x",
      AGENT_LOOP_DEVELOPER_PROVIDER: "openai",
      AGENT_LOOP_DEVELOPER_MODEL: "m",
      AGENT_LOOP_DEVELOPER_AUTH: "api_key",
      AGENT_LOOP_DEVELOPER_API_KEY: "x",
    });
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
  });

  it("approve/cancel/logs on a nonexistent run all fail with an actionable RUN_NOT_FOUND error", async () => {
    const { stateDir } = scratchDirs();
    const env = {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_REVIEWER_PROVIDER: "openai",
      AGENT_LOOP_REVIEWER_MODEL: "m",
      AGENT_LOOP_REVIEWER_AUTH: "api_key",
      AGENT_LOOP_REVIEWER_API_KEY: "x",
      AGENT_LOOP_DEVELOPER_PROVIDER: "openai",
      AGENT_LOOP_DEVELOPER_MODEL: "m",
      AGENT_LOOP_DEVELOPER_AUTH: "api_key",
      AGENT_LOOP_DEVELOPER_API_KEY: "x",
    };
    for (const args of [
      ["approve", "does-not-exist"],
      ["cancel", "does-not-exist"],
      ["logs", "does-not-exist"],
    ]) {
      const result = await runCli(args, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("RUN_NOT_FOUND");
    }
  });

  it("runs an entire plan -> approve -> execute -> review cycle through the real CLI using a fake provider CLI (auth=cli, no network)", async () => {
    const { workspace, stateDir } = scratchDirs();
    const env = {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_WORKSPACE: workspace,
      AGENT_LOOP_APPROVAL_MODE: "all",
      AGENT_LOOP_REVIEWER_PROVIDER: "fake",
      AGENT_LOOP_REVIEWER_MODEL: "fake-model",
      AGENT_LOOP_REVIEWER_AUTH: "cli",
      AGENT_LOOP_REVIEWER_CLI_CHECK_COMMAND: "true",
      AGENT_LOOP_REVIEWER_CLI_EXEC_COMMAND: fakeProviderCli,
      AGENT_LOOP_DEVELOPER_PROVIDER: "fake",
      AGENT_LOOP_DEVELOPER_MODEL: "fake-model",
      AGENT_LOOP_DEVELOPER_AUTH: "cli",
      AGENT_LOOP_DEVELOPER_CLI_CHECK_COMMAND: "true",
      AGENT_LOOP_DEVELOPER_CLI_EXEC_COMMAND: fakeProviderCli,
    };

    const result = await runCli(
      ["run", "write a greeting file", "--json"],
      env,
    );
    expect(result.code).toBe(0);
    expect(existsSync(path.join(workspace, "greeting.txt"))).toBe(true);
    expect(readFileSync(path.join(workspace, "greeting.txt"), "utf8")).toBe(
      "hello from the fake provider CLI",
    );

    // --json must be pure JSON Lines: every non-empty stdout line parses,
    // and includes the expected lifecycle events.
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const events = lines.map((l) => JSON.parse(l)); // throws if any line isn't valid JSON
    const types = events.map((e) => e.type);
    expect(types).toContain("run_started");
    expect(types).toContain("plan_ready");
    expect(types).toContain("run_completed");
  }, 20_000);

  it("--quiet suppresses nonessential events but keeps run-lifecycle events, in the same real end-to-end run", async () => {
    const { workspace, stateDir } = scratchDirs();
    const env = {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_WORKSPACE: workspace,
      AGENT_LOOP_APPROVAL_MODE: "all",
      AGENT_LOOP_REVIEWER_PROVIDER: "fake",
      AGENT_LOOP_REVIEWER_MODEL: "fake-model",
      AGENT_LOOP_REVIEWER_AUTH: "cli",
      AGENT_LOOP_REVIEWER_CLI_CHECK_COMMAND: "true",
      AGENT_LOOP_REVIEWER_CLI_EXEC_COMMAND: fakeProviderCli,
      AGENT_LOOP_DEVELOPER_PROVIDER: "fake",
      AGENT_LOOP_DEVELOPER_MODEL: "fake-model",
      AGENT_LOOP_DEVELOPER_AUTH: "cli",
      AGENT_LOOP_DEVELOPER_CLI_CHECK_COMMAND: "true",
      AGENT_LOOP_DEVELOPER_CLI_EXEC_COMMAND: fakeProviderCli,
    };

    const result = await runCli(
      ["run", "write a greeting file", "--json", "--quiet"],
      env,
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain("run_started");
    expect(types).toContain("run_completed");
    expect(types).not.toContain("task_started");
    expect(types).not.toContain("command_started");
    expect(types).not.toContain("progress");
  }, 20_000);

  it("concurrent `status` and `logs` reads against the same run do not error or corrupt output", async () => {
    const { workspace, stateDir } = scratchDirs();
    const env = {
      AGENT_LOOP_STATE_DIR: stateDir,
      AGENT_LOOP_WORKSPACE: workspace,
      AGENT_LOOP_APPROVAL_MODE: "all",
      AGENT_LOOP_REVIEWER_PROVIDER: "fake",
      AGENT_LOOP_REVIEWER_MODEL: "fake-model",
      AGENT_LOOP_REVIEWER_AUTH: "cli",
      AGENT_LOOP_REVIEWER_CLI_CHECK_COMMAND: "true",
      AGENT_LOOP_REVIEWER_CLI_EXEC_COMMAND: fakeProviderCli,
      AGENT_LOOP_DEVELOPER_PROVIDER: "fake",
      AGENT_LOOP_DEVELOPER_MODEL: "fake-model",
      AGENT_LOOP_DEVELOPER_AUTH: "cli",
      AGENT_LOOP_DEVELOPER_CLI_CHECK_COMMAND: "true",
      AGENT_LOOP_DEVELOPER_CLI_EXEC_COMMAND: fakeProviderCli,
    };

    const runResult = await runCli(
      ["run", "write a greeting file", "--json"],
      env,
    );
    expect(runResult.code).toBe(0);
    const runId = JSON.parse(runResult.stdout.trim().split("\n")[0]!).runId;
    expect(typeof runId).toBe("string");

    const [statusA, statusB, logs] = await Promise.all([
      runCli(["status", runId, "--json"], env),
      runCli(["status", runId, "--json"], env),
      runCli(["logs", runId, "--json"], env),
    ]);
    expect(statusA.code).toBe(0);
    expect(statusB.code).toBe(0);
    expect(logs.code).toBe(0);
    expect(() => JSON.parse(statusA.stdout.trim())).not.toThrow();
    expect(() => JSON.parse(statusB.stdout.trim())).not.toThrow();
  }, 20_000);
});

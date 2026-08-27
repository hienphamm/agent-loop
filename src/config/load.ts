import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { ConfigError } from "../errors/index.js";
import {
  AgentLoopConfigSchema,
  PROVIDER_API_KEY_ENV,
  type AgentLoopConfig,
  type ApprovalMode,
  type AuthMode,
} from "./schema.js";

export interface CliOverrides {
  workspace?: string;
  approvalMode?: ApprovalMode;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerAuth?: AuthMode;
  developerProvider?: string;
  developerModel?: string;
  developerAuth?: AuthMode;
  envFile?: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  overrides?: CliOverrides;
  /** Skip reading process.env / .env, used by tests to supply a fully synthetic env. */
  env?: Record<string, string | undefined>;
}

export interface ConfigWarning {
  code: string;
  message: string;
}

export interface LoadConfigResult {
  config: AgentLoopConfig;
  warnings: ConfigWarning[];
}

/**
 * Loads configuration in precedence order (lowest to highest):
 *   built-in defaults  <  .env file  <  process.env  <  CLI flag overrides
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const overrides = options.overrides ?? {};
  const warnings: ConfigWarning[] = [];

  const envFilePath = path.resolve(cwd, overrides.envFile ?? ".env");
  let fileEnv: Record<string, string> = {};
  if (existsSync(envFilePath)) {
    fileEnv = parseDotenv(readFileSync(envFilePath, "utf8"));
    warnEnvFileNotIgnored(cwd, envFilePath, warnings);
  }

  const baseEnv = options.env ?? process.env;
  const env: Record<string, string | undefined> = { ...fileEnv, ...baseEnv };

  const workspace =
    overrides.workspace ?? env.AGENT_LOOP_WORKSPACE ?? "./workspace";
  const approvalMode = (overrides.approvalMode ??
    (env.AGENT_LOOP_APPROVAL_MODE as ApprovalMode | undefined) ??
    "manual") as ApprovalMode;

  const reviewerAuth = (overrides.reviewerAuth ??
    (env.AGENT_LOOP_REVIEWER_AUTH as AuthMode | undefined)) as
    AuthMode | undefined;
  const developerAuth = (overrides.developerAuth ??
    (env.AGENT_LOOP_DEVELOPER_AUTH as AuthMode | undefined)) as
    AuthMode | undefined;

  const reviewerProvider =
    overrides.reviewerProvider ?? env.AGENT_LOOP_REVIEWER_PROVIDER;
  const developerProvider =
    overrides.developerProvider ?? env.AGENT_LOOP_DEVELOPER_PROVIDER;

  const candidate = {
    workspace: path.resolve(cwd, workspace),
    approvalMode,
    stateDir: path.resolve(cwd, env.AGENT_LOOP_STATE_DIR ?? ".agent-loop"),
    contextTokenBudget: numberOr(env.AGENT_LOOP_CONTEXT_TOKEN_BUDGET, 100_000),
    maxReviewRounds: numberOr(env.AGENT_LOOP_MAX_REVIEW_ROUNDS, 3),
    reviewer: {
      provider: reviewerProvider ?? "",
      model: overrides.reviewerModel ?? env.AGENT_LOOP_REVIEWER_MODEL ?? "",
      auth: reviewerAuth ?? "api_key",
      apiKey: resolveApiKey("reviewer", reviewerProvider, env),
      cliCheckCommand: env.AGENT_LOOP_REVIEWER_CLI_CHECK_COMMAND,
      cliLoginCommand: env.AGENT_LOOP_REVIEWER_CLI_LOGIN_COMMAND,
      cliExecCommand: env.AGENT_LOOP_REVIEWER_CLI_EXEC_COMMAND,
    },
    developer: {
      provider: developerProvider ?? "",
      model: overrides.developerModel ?? env.AGENT_LOOP_DEVELOPER_MODEL ?? "",
      auth: developerAuth ?? "api_key",
      apiKey: resolveApiKey("developer", developerProvider, env),
      cliCheckCommand: env.AGENT_LOOP_DEVELOPER_CLI_CHECK_COMMAND,
      cliLoginCommand: env.AGENT_LOOP_DEVELOPER_CLI_LOGIN_COMMAND,
      cliExecCommand: env.AGENT_LOOP_DEVELOPER_CLI_EXEC_COMMAND,
    },
  };

  const parsed = AgentLoopConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new ConfigError(
      `Invalid configuration:\n${details}`,
      "Check your .env file against .env.example, or pass the missing values as CLI flags.",
    );
  }

  // Explicit-mode validation: never silently fall back between auth modes.
  for (const role of ["reviewer", "developer"] as const) {
    const roleConfig = parsed.data[role];
    if (roleConfig.auth === "api_key" && !roleConfig.apiKey) {
      throw new ConfigError(
        `${role} auth mode is "api_key" but no API key was found`,
        `Set AGENT_LOOP_${role.toUpperCase()}_API_KEY, or ${PROVIDER_API_KEY_ENV[roleConfig.provider] ?? "a provider-specific *_API_KEY"} in your .env, or switch to --${role}-auth cli.`,
      );
    }
    if (roleConfig.auth === "cli" && !roleConfig.cliCheckCommand) {
      warnings.push({
        code: "CLI_CHECK_COMMAND_MISSING",
        message: `${role} auth mode is "cli" but no cliCheckCommand is configured; \`auth check\` will assume the session is valid.`,
      });
    }
  }

  return { config: parsed.data, warnings };
}

function resolveApiKey(
  role: "reviewer" | "developer",
  provider: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const roleSpecific = env[`AGENT_LOOP_${role.toUpperCase()}_API_KEY`];
  if (roleSpecific) return roleSpecific;
  if (provider && PROVIDER_API_KEY_ENV[provider]) {
    return env[PROVIDER_API_KEY_ENV[provider] as string];
  }
  return undefined;
}

function numberOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function warnEnvFileNotIgnored(
  cwd: string,
  envFilePath: string,
  warnings: ConfigWarning[],
): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!existsSync(gitignorePath)) {
    warnings.push({
      code: "ENV_NOT_GITIGNORED",
      message: `No .gitignore found in ${cwd}; ${path.basename(envFilePath)} could be committed by accident.`,
    });
    return;
  }
  const gitignore = readFileSync(gitignorePath, "utf8");
  const ignoresEnv = gitignore
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === ".env" || l === "*.env" || l === "/.env");
  if (!ignoresEnv) {
    warnings.push({
      code: "ENV_NOT_GITIGNORED",
      message: `.gitignore does not appear to exclude .env; add a ".env" entry to avoid committing secrets.`,
    });
  }
}

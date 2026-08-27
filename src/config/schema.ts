import { z } from "zod";

export const AuthModeSchema = z.enum(["cli", "api_key"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const ApprovalModeSchema = z.enum(["manual", "safe", "all"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const RoleConfigSchema = z.object({
  provider: z.string().min(1, "provider must not be empty"),
  model: z.string().min(1, "model must not be empty"),
  auth: AuthModeSchema,
  apiKey: z.string().optional(),
  cliCheckCommand: z.string().optional(),
  cliLoginCommand: z.string().optional(),
  cliExecCommand: z.string().optional(),
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const AgentLoopConfigSchema = z.object({
  workspace: z.string().min(1, "workspace must be set"),
  approvalMode: ApprovalModeSchema,
  reviewer: RoleConfigSchema,
  developer: RoleConfigSchema,
  contextTokenBudget: z.number().int().positive(),
  maxReviewRounds: z.number().int().positive(),
  stateDir: z.string().min(1),
});
export type AgentLoopConfig = z.infer<typeof AgentLoopConfigSchema>;

/** Provider-specific env var fallbacks used when a role's own *_API_KEY is unset. */
export const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  mock: "AGENT_LOOP_MOCK_API_KEY",
};

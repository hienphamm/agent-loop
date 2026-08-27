import type { RoleConfig } from "../config/schema.js";
import { AuthError } from "../errors/index.js";
import { ApiKeyAuth } from "./apiKey.js";
import { CliSessionAuth } from "./cliSession.js";
import type { AuthAdapter } from "./types.js";

/**
 * Builds the auth adapter for a role strictly from its configured mode.
 * There is no fallback between modes: if "api_key" is selected and no key
 * is present, this throws rather than silently trying a CLI session (and
 * vice versa).
 */
export function createAuthAdapter(
  roleName: "reviewer" | "developer",
  config: RoleConfig,
): AuthAdapter {
  if (config.auth === "api_key") {
    if (!config.apiKey) {
      throw new AuthError(
        `${roleName}: auth mode is "api_key" but no API key is configured`,
        `Set AGENT_LOOP_${roleName.toUpperCase()}_API_KEY (or the provider-specific *_API_KEY) in .env.`,
      );
    }
    return new ApiKeyAuth(roleName, config.apiKey);
  }
  return new CliSessionAuth(
    roleName,
    config.cliCheckCommand,
    config.cliLoginCommand,
  );
}

import type { RoleConfig } from "../config/schema.js";
import { ConfigError } from "../errors/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { CliExecProvider } from "./cliExec.js";
import { MockProvider, type MockResponder } from "./mock.js";
import { OpenAiProvider } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

export interface ProviderFactoryOptions {
  /** Only used for provider "mock"; lets tests/dry-run inject scripted behavior. */
  mockResponder?: MockResponder;
}

/**
 * Builds the provider adapter for a role. Auth mode "cli" always routes
 * through the generic CLI-exec adapter, regardless of provider name, since
 * the whole point of that mode is "whatever the provider's own CLI does".
 * Auth mode "api_key" routes to a provider-specific HTTP adapter.
 */
export function createProviderAdapter(
  roleName: "reviewer" | "developer",
  config: RoleConfig,
  options: ProviderFactoryOptions = {},
): ProviderAdapter {
  if (config.provider === "mock") {
    if (!options.mockResponder) {
      throw new ConfigError(
        `${roleName}: provider "mock" requires a mockResponder to be supplied`,
      );
    }
    return new MockProvider(options.mockResponder);
  }

  if (config.auth === "cli") {
    if (!config.cliExecCommand) {
      throw new ConfigError(
        `${roleName}: auth mode "cli" requires a cliExecCommand`,
        `Set AGENT_LOOP_${roleName.toUpperCase()}_CLI_EXEC_COMMAND to the command that runs a completion via the provider's CLI.`,
      );
    }
    return new CliExecProvider(config.cliExecCommand);
  }

  switch (config.provider) {
    case "openai":
      return new OpenAiProvider(requireApiKey(roleName, config));
    case "anthropic":
      return new AnthropicProvider(requireApiKey(roleName, config));
    default:
      throw new ConfigError(
        `${roleName}: unknown provider "${config.provider}"`,
        `Supported providers: openai, anthropic, mock (or auth mode "cli" with any provider name).`,
      );
  }
}

function requireApiKey(roleName: string, config: RoleConfig): string {
  if (!config.apiKey) {
    throw new ConfigError(
      `${roleName}: no API key configured for provider "${config.provider}"`,
    );
  }
  return config.apiKey;
}

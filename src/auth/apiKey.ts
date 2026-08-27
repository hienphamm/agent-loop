import { registerSecret } from "./redact.js";
import type { AuthAdapter, AuthCheckResult } from "./types.js";

/**
 * Direct API key authentication. The key is registered for redaction as soon
 * as it is known, before it can ever reach a log line or event.
 */
export class ApiKeyAuth implements AuthAdapter {
  readonly mode = "api_key" as const;

  constructor(
    private readonly roleName: string,
    private readonly apiKey: string | undefined,
  ) {
    registerSecret(apiKey);
  }

  getApiKey(): string {
    if (!this.apiKey) {
      throw new Error(
        `${this.roleName}: api_key auth mode selected but no key is configured`,
      );
    }
    return this.apiKey;
  }

  async check(): Promise<AuthCheckResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: `${this.roleName}: no API key configured`,
        remedyCommand: `set AGENT_LOOP_${this.roleName.toUpperCase()}_API_KEY in .env`,
      };
    }
    return { ok: true, message: `${this.roleName}: API key configured` };
  }
}

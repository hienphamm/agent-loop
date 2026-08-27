import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthAdapter, AuthCheckResult } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Provider CLI login/session authentication. Runs a user-configured "check"
 * command and reports whether the session is active. No API key is ever
 * read, stored, or required in this mode.
 */
export class CliSessionAuth implements AuthAdapter {
  readonly mode = "cli" as const;

  constructor(
    private readonly roleName: string,
    private readonly checkCommand: string | undefined,
    private readonly loginCommand: string | undefined,
  ) {}

  async check(): Promise<AuthCheckResult> {
    if (!this.checkCommand) {
      return {
        ok: true,
        message: `${this.roleName}: cli auth mode selected but no check command configured; assuming session is valid`,
      };
    }
    try {
      await execFileAsync(this.commandBin(), this.commandArgs(), {
        timeout: 15_000,
      });
      return {
        ok: true,
        message: `${this.roleName}: provider CLI session is active`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `${this.roleName}: provider CLI session check failed (${(error as Error).message})`,
        remedyCommand: this.loginCommand ?? "(no login command configured)",
      };
    }
  }

  private commandBin(): string {
    return this.checkCommand!.split(" ")[0] as string;
  }

  private commandArgs(): string[] {
    return this.checkCommand!.split(" ").slice(1);
  }
}

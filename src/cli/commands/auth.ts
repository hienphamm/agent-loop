import { Command } from "commander";
import { createAuthAdapter } from "../../auth/factory.js";
import {
  buildCliContext,
  printError,
  type GlobalCliFlags,
} from "../context.js";

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Inspect authentication configuration and session status");

  auth
    .command("status")
    .description(
      "Show configured auth mode/provider/model per role (no network calls, no secret values)",
    )
    .option("--json")
    .option("--workspace <dir>")
    .option("--env-file <path>")
    .action((flags: GlobalCliFlags) => {
      const ctx = buildCliContext(flags);
      try {
        const summary = {
          reviewer: {
            provider: ctx.config.reviewer.provider,
            model: ctx.config.reviewer.model,
            auth: ctx.config.reviewer.auth,
            apiKeyConfigured: Boolean(ctx.config.reviewer.apiKey),
          },
          developer: {
            provider: ctx.config.developer.provider,
            model: ctx.config.developer.model,
            auth: ctx.config.developer.auth,
            apiKeyConfigured: Boolean(ctx.config.developer.apiKey),
          },
        };
        if (flags.json) {
          process.stdout.write(JSON.stringify(summary) + "\n");
        } else {
          for (const [role, info] of Object.entries(summary)) {
            process.stdout.write(
              `${role}: provider=${info.provider} model=${info.model} auth=${info.auth} apiKeyConfigured=${info.apiKeyConfigured}\n`,
            );
          }
        }
      } finally {
        ctx.detachStream();
      }
    });

  auth
    .command("check")
    .description("Actively verify the reviewer and developer sessions/keys")
    .option("--json")
    .option("--workspace <dir>")
    .option("--env-file <path>")
    .action(async (flags: GlobalCliFlags) => {
      const ctx = buildCliContext(flags);
      try {
        const results: Record<string, unknown> = {};
        let allOk = true;
        for (const role of ["reviewer", "developer"] as const) {
          const adapter = createAuthAdapter(role, ctx.config[role]);
          const result = await adapter.check();
          allOk = allOk && result.ok;
          results[role] = result;
          if (flags.json) continue;
          process.stdout.write(
            `${role}: ${result.ok ? "OK" : "FAILED"} — ${result.message}\n`,
          );
          if (!result.ok && result.remedyCommand) {
            process.stdout.write(`  fix: ${result.remedyCommand}\n`);
          }
        }
        if (flags.json) {
          process.stdout.write(JSON.stringify({ ok: allOk, results }) + "\n");
        }
        process.exitCode = allOk ? 0 : 1;
      } catch (error) {
        printError(error, flags.json);
        process.exitCode = 1;
      } finally {
        ctx.detachStream();
      }
    });
}

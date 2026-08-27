import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { createAuthAdapter } from "../../auth/factory.js";
import { createProviderAdapter } from "../../providers/registry.js";
import { runOrchestration } from "../../orchestration/runLoop.js";
import { AuthError } from "../../errors/index.js";
import {
  buildCliContext,
  printError,
  type GlobalCliFlags,
} from "../context.js";

interface RunFlags extends GlobalCliFlags {
  concurrency?: string;
  dryRun?: boolean;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run <prompt>")
    .description("Start a new run: plan, get approval, execute, and review")
    .option("--workspace <dir>", "workspace root the Executor may touch")
    .option("--approval-mode <mode>", "manual | safe | all")
    .option("--reviewer-provider <name>")
    .option("--reviewer-model <name>")
    .option("--reviewer-auth <mode>", "cli | api_key")
    .option("--developer-provider <name>")
    .option("--developer-model <name>")
    .option("--developer-auth <mode>", "cli | api_key")
    .option("--env-file <path>")
    .option("--concurrency <n>", "max parallel tasks", "2")
    .option("--dry-run", "plan and log actions without executing them")
    .option(
      "--json",
      "emit newline-delimited JSON events instead of human summaries",
    )
    .option("--verbose-stream", "also emit raw model tokens")
    .option(
      "--quiet",
      "suppress nonessential output (progress, per-command/task chatter)",
    )
    .action(async (prompt: string, flags: RunFlags) => {
      const ctx = buildCliContext(flags);
      let cancelled = false;
      const onSignal = () => {
        cancelled = true;
        process.stderr.write(
          "\nCancellation requested; finishing the current step safely...\n",
        );
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      try {
        for (const role of ["reviewer", "developer"] as const) {
          const auth = createAuthAdapter(role, ctx.config[role]);
          const result = await auth.check();
          if (!result.ok) {
            throw new AuthError(result.message, result.remedyCommand);
          }
        }

        const reviewerProvider = createProviderAdapter(
          "reviewer",
          ctx.config.reviewer,
        );
        const developerProvider = createProviderAdapter(
          "developer",
          ctx.config.developer,
        );

        const runId = randomUUID();
        // Under --json, stdout must be JSON Lines only (the run_started
        // event already carries this runId) — a scripting/CI consumer
        // piping this into a JSON parser must never see a stray text line.
        if (!flags.json) {
          process.stdout.write(`run id: ${runId}\n`);
        }

        const run = await runOrchestration({
          runId,
          prompt,
          config: ctx.config,
          repository: ctx.repository,
          events: ctx.events,
          reviewerProvider,
          developerProvider,
          dryRun: flags.dryRun,
          concurrency: Number(flags.concurrency ?? "2"),
          isCancelled: () =>
            cancelled || ctx.repository.getRun(runId)?.status === "cancelled",
        });

        process.exitCode = run.status === "completed" ? 0 : 1;
      } catch (error) {
        printError(error, flags.json);
        process.exitCode = 1;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        ctx.detachStream();
      }
    });
}

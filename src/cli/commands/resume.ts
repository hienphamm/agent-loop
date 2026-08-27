import { Command } from "commander";
import { createAuthAdapter } from "../../auth/factory.js";
import { createProviderAdapter } from "../../providers/registry.js";
import { runOrchestration } from "../../orchestration/runLoop.js";
import { AuthError, RunNotFoundError } from "../../errors/index.js";
import {
  buildCliContext,
  printError,
  type GlobalCliFlags,
} from "../context.js";

export function registerResumeCommand(program: Command): void {
  program
    .command("resume <runId>")
    .description(
      "Resume a run after a crash or restart, skipping completed tasks",
    )
    .option(
      "--json",
      "emit newline-delimited JSON events instead of human summaries",
    )
    .option("--verbose-stream", "also emit raw model tokens")
    .option(
      "--quiet",
      "suppress nonessential output (progress, per-command/task chatter)",
    )
    .option("--concurrency <n>", "max parallel tasks", "2")
    .action(
      async (
        runId: string,
        flags: GlobalCliFlags & { concurrency?: string },
      ) => {
        const ctx = buildCliContext(flags);
        let cancelled = false;
        const onSignal = () => {
          cancelled = true;
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);

        try {
          const existing = ctx.repository.getRun(runId);
          if (!existing) throw new RunNotFoundError(runId);

          for (const role of ["reviewer", "developer"] as const) {
            const auth = createAuthAdapter(role, ctx.config[role]);
            const result = await auth.check();
            if (!result.ok)
              throw new AuthError(result.message, result.remedyCommand);
          }

          const reviewerProvider = createProviderAdapter(
            "reviewer",
            ctx.config.reviewer,
          );
          const developerProvider = createProviderAdapter(
            "developer",
            ctx.config.developer,
          );

          const run = await runOrchestration({
            runId,
            config: ctx.config,
            repository: ctx.repository,
            events: ctx.events,
            reviewerProvider,
            developerProvider,
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
      },
    );
}

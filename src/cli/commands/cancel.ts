import { Command } from "commander";
import { RunNotFoundError } from "../../errors/index.js";
import {
  buildCliContext,
  printError,
  type GlobalCliFlags,
} from "../context.js";

export function registerCancelCommand(program: Command): void {
  program
    .command("cancel <runId>")
    .description(
      "Cancel a run; a running `agent-loop run`/`resume` process will stop at the next safe point",
    )
    .option("--json")
    .action(async (runId: string, flags: GlobalCliFlags) => {
      const ctx = buildCliContext(flags);
      try {
        const run = ctx.repository.getRun(runId);
        if (!run) throw new RunNotFoundError(runId);
        ctx.repository.updateRunStatus(runId, "cancelled");
        if (flags.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, runId, status: "cancelled" }) + "\n",
          );
        } else {
          process.stdout.write(`Run ${runId} marked cancelled.\n`);
        }
      } catch (error) {
        printError(error, flags.json);
        process.exitCode = 1;
      } finally {
        ctx.detachStream();
      }
    });
}

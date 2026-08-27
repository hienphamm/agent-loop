import { Command } from "commander";
import { setTimeout as sleep } from "node:timers/promises";
import { RunNotFoundError } from "../../errors/index.js";
import { isVerboseEvent } from "../../events/types.js";
import {
  buildCliContext,
  printError,
  type GlobalCliFlags,
} from "../context.js";

interface LogsFlags extends GlobalCliFlags {
  follow?: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function registerLogsCommand(program: Command): void {
  program
    .command("logs <runId>")
    .description("Show (or follow) the event log for a run")
    .option("--follow", "keep polling until the run reaches a terminal state")
    .option("--json", "print one JSON event per line")
    .action(async (runId: string, flags: LogsFlags) => {
      const ctx = buildCliContext(flags);
      try {
        const run = ctx.repository.getRun(runId);
        if (!run) throw new RunNotFoundError(runId);

        let sinceSeq = 0;
        const printBatch = () => {
          const events = ctx.repository.listEvents(runId, sinceSeq);
          for (const event of events) {
            if (isVerboseEvent(event.type) && !flags.verboseStream) continue;
            sinceSeq = event.seq;
            if (flags.json) {
              process.stdout.write(JSON.stringify(event) + "\n");
            } else {
              process.stdout.write(
                `[${event.timestamp}] ${event.type}${event.taskId ? ` (${event.taskId})` : ""} ${JSON.stringify(event.data)}\n`,
              );
            }
          }
        };

        printBatch();
        if (flags.follow) {
          while (
            !TERMINAL_STATUSES.has(
              ctx.repository.getRun(runId)?.status ?? "completed",
            )
          ) {
            await sleep(1000);
            printBatch();
          }
          printBatch();
        }
      } catch (error) {
        printError(error, flags.json);
        process.exitCode = 1;
      } finally {
        ctx.detachStream();
      }
    });
}

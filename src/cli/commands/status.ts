import { Command } from "commander";
import { RunNotFoundError } from "../../errors/index.js";
import {
  buildCliContext,
  printError,
  type GlobalCliFlags,
} from "../context.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status [runId]")
    .description("Show recent runs, or full detail for one run")
    .option("--json", "print machine-readable JSON")
    .action(async (runId: string | undefined, flags: GlobalCliFlags) => {
      const ctx = buildCliContext(flags);
      try {
        if (!runId) {
          const runs = ctx.repository.listRuns();
          if (flags.json) {
            process.stdout.write(JSON.stringify(runs) + "\n");
          } else if (runs.length === 0) {
            process.stdout.write("No runs yet.\n");
          } else {
            for (const run of runs) {
              process.stdout.write(
                `${run.id}  ${run.status.padEnd(16)}  ${run.createdAt}  ${run.prompt.slice(0, 60)}\n`,
              );
            }
          }
          return;
        }

        const run = ctx.repository.getRun(runId);
        if (!run) throw new RunNotFoundError(runId);
        const tasks = ctx.repository.listTasks(runId);
        const approvals = ctx.repository.listApprovals(runId);
        const checkpoints = ctx.repository.listCheckpoints(runId);

        if (flags.json) {
          process.stdout.write(
            JSON.stringify({ run, tasks, approvals, checkpoints }) + "\n",
          );
          return;
        }

        process.stdout.write(`run ${run.id}  status=${run.status}\n`);
        process.stdout.write(`prompt: ${run.prompt}\n`);
        process.stdout.write(`workspace: ${run.workspace}\n\n`);
        process.stdout.write(`tasks (${tasks.length}):\n`);
        for (const task of tasks) {
          process.stdout.write(
            `  [${task.status.padEnd(9)}] ${task.id}  retries=${task.retryCount}  ${task.description.slice(0, 70)}\n`,
          );
        }
        const pendingApprovals = approvals.filter(
          (a) => a.status === "pending",
        );
        if (pendingApprovals.length > 0) {
          process.stdout.write(`\npending approvals:\n`);
          for (const approval of pendingApprovals) {
            process.stdout.write(
              `  ${approval.id}  ${approval.scope}  ${approval.summary}\n`,
            );
          }
        }
      } catch (error) {
        printError(error, flags.json);
        process.exitCode = 1;
      } finally {
        ctx.detachStream();
      }
    });
}

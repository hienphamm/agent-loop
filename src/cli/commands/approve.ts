import { Command } from "commander";
import { AgentLoopError, RunNotFoundError } from "../../errors/index.js";
import {
  buildCliContext,
  printError,
  type GlobalCliFlags,
} from "../context.js";

interface ApproveFlags extends GlobalCliFlags {
  task?: string;
  reject?: boolean;
}

export function registerApproveCommand(program: Command): void {
  program
    .command("approve <runId>")
    .description("Approve (or reject) a pending plan/task approval")
    .option(
      "--task <taskId>",
      "approve a specific task's pending approval instead of the whole plan",
    )
    .option("--reject", "reject instead of approve")
    .option("--json")
    .action(async (runId: string, flags: ApproveFlags) => {
      const ctx = buildCliContext(flags);
      try {
        const run = ctx.repository.getRun(runId);
        if (!run) throw new RunNotFoundError(runId);

        const pending = ctx.repository.getPendingApproval(runId, flags.task);
        if (!pending) {
          throw new AgentLoopError(
            "NO_PENDING_APPROVAL",
            `No pending approval found for run ${runId}${flags.task ? ` / task ${flags.task}` : ""}`,
          );
        }

        const resolved = ctx.repository.resolveApproval(
          pending.id,
          flags.reject ? "rejected" : "approved",
        );
        if (!resolved) {
          // Lost a race with another `approve`/`cancel` invocation between
          // the read above and the compare-and-set write: someone else
          // already resolved this exact approval.
          const current = ctx.repository.getApproval(pending.id);
          throw new AgentLoopError(
            "APPROVAL_ALREADY_RESOLVED",
            `Approval ${pending.id} was already resolved (${current?.status ?? "unknown"}) by ${current?.decidedBy ?? "someone else"} before this request completed`,
          );
        }
        const message = `${flags.reject ? "Rejected" : "Approved"} ${pending.scope} "${pending.summary}"`;
        if (flags.json) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              approvalId: pending.id,
              decision: flags.reject ? "rejected" : "approved",
            }) + "\n",
          );
        } else {
          process.stdout.write(
            `${message}\nRun \`agent-loop resume ${runId}\` to continue.\n`,
          );
        }
      } catch (error) {
        printError(error, flags.json);
        process.exitCode = 1;
      } finally {
        ctx.detachStream();
      }
    });
}

#!/usr/bin/env node
import { Command } from "commander";
import { registerRunCommand } from "./commands/run.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerAuthCommand } from "./commands/auth.js";
import { redact } from "../auth/redact.js";

// Last-resort safety nets: even an error that escapes every try/catch below
// (a bug, a library throwing something unexpected) must never dump a raw,
// unredacted message to the terminal or a crash log.
process.on("uncaughtException", (error) => {
  process.stderr.write(`Fatal (uncaught): ${redact(error.message)}\n`);
  process.exitCode = 1;
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`Fatal (unhandled rejection): ${redact(message)}\n`);
  process.exitCode = 1;
});

const program = new Command();
program
  .name("agent-loop")
  .description(
    "CLI-first, local-only Planner/Reviewer + Developer/Executor agent orchestrator",
  )
  .version("0.1.0");

registerRunCommand(program);
registerResumeCommand(program);
registerStatusCommand(program);
registerApproveCommand(program);
registerCancelCommand(program);
registerLogsCommand(program);
registerAuthCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal: ${redact(message)}\n`);
  process.exitCode = 1;
});

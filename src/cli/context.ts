import type { AgentLoopConfig } from "../config/schema.js";
import { loadConfig, type CliOverrides } from "../config/load.js";
import { openDatabase } from "../persistence/db.js";
import { Repository } from "../persistence/repository.js";
import { EventBus } from "../events/bus.js";
import { attachStreamRenderer } from "../events/stream.js";
import { toDisplayError } from "../errors/index.js";

export interface GlobalCliFlags {
  workspace?: string;
  approvalMode?: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerAuth?: string;
  developerProvider?: string;
  developerModel?: string;
  developerAuth?: string;
  envFile?: string;
  json?: boolean;
  verboseStream?: boolean;
  quiet?: boolean;
}

export interface CliContext {
  config: AgentLoopConfig;
  repository: Repository;
  events: EventBus;
  detachStream: () => void;
}

export function buildCliContext(flags: GlobalCliFlags): CliContext {
  const overrides: CliOverrides = {};
  if (flags.workspace) overrides.workspace = flags.workspace;
  if (flags.approvalMode)
    overrides.approvalMode = flags.approvalMode as CliOverrides["approvalMode"];
  if (flags.reviewerProvider)
    overrides.reviewerProvider = flags.reviewerProvider;
  if (flags.reviewerModel) overrides.reviewerModel = flags.reviewerModel;
  if (flags.reviewerAuth)
    overrides.reviewerAuth = flags.reviewerAuth as CliOverrides["reviewerAuth"];
  if (flags.developerProvider)
    overrides.developerProvider = flags.developerProvider;
  if (flags.developerModel) overrides.developerModel = flags.developerModel;
  if (flags.developerAuth)
    overrides.developerAuth =
      flags.developerAuth as CliOverrides["developerAuth"];
  if (flags.envFile) overrides.envFile = flags.envFile;

  const { config, warnings } = loadConfig({ overrides });
  for (const warning of warnings) {
    process.stderr.write(`warning [${warning.code}]: ${warning.message}\n`);
  }

  const db = openDatabase(config.stateDir);
  const repository = new Repository(db);
  const events = new EventBus();

  // Note: persisting events into `repository` happens inside
  // `runOrchestration` itself (see runLoop.ts), not here — that's the
  // single place that drives the bus for a run, so it's the single place
  // that should write events table rows, regardless of which process or
  // API surface called it.
  const detachStream = attachStreamRenderer(events, {
    json: flags.json,
    verbose: flags.verboseStream,
    quiet: flags.quiet,
  });

  return { config, repository, events, detachStream };
}

export function printError(error: unknown, json?: boolean): void {
  const display = toDisplayError(error);
  if (json) {
    process.stderr.write(JSON.stringify({ error: display }) + "\n");
  } else {
    process.stderr.write(`Error [${display.code}]: ${display.message}\n`);
    if (display.hint) process.stderr.write(`Hint: ${display.hint}\n`);
  }
}

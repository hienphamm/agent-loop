import { isVerboseEvent, type BaseEvent } from "./types.js";
import type { EventBus } from "./bus.js";

export interface StreamOptions {
  /** Emit raw model tokens too. Off by default. */
  verbose?: boolean;
  /** Emit one JSON object per line instead of a human-readable summary. */
  json?: boolean;
  /** Suppress nonessential/high-frequency events (progress, command/task start-stop, context_compacted). */
  quiet?: boolean;
  write?: (line: string) => void;
}

/** Event types considered "nonessential" and suppressed under --quiet. */
const QUIET_SUPPRESSED = new Set<BaseEvent["type"]>([
  "progress",
  "command_started",
  "command_completed",
  "task_started",
  "task_completed",
  "context_compacted",
  "model_token",
]);

const HUMAN_SUMMARY: Partial<
  Record<BaseEvent["type"], (e: BaseEvent) => string>
> = {
  run_started: (e) => `run ${e.runId} started: ${String(e.data.prompt ?? "")}`,
  plan_ready: (e) =>
    `plan ready with ${String(e.data.taskCount ?? "?")} task(s)`,
  approval_required: (e) =>
    `approval required: ${String(e.data.summary ?? e.taskId ?? "")}`,
  approval_resolved: (e) =>
    `approval ${String(e.data.decision ?? "")}: ${String(e.data.summary ?? "")}`,
  task_started: (e) =>
    `task ${e.taskId} started: ${String(e.data.description ?? "")}`,
  command_started: (e) => `  $ ${String(e.data.command ?? "")}`,
  command_completed: (e) => {
    const outcome = e.data.signal
      ? `signal ${String(e.data.signal)}`
      : `exit ${String(e.data.exitCode ?? "?")}`;
    const base = `  (${outcome}) ${String(e.data.command ?? "")}`;
    if (e.data.success === false) {
      return `${base} FAILED [${String(e.data.failureReason ?? "?")}] expected=${JSON.stringify(e.data.expectedExitCodes ?? [])}`;
    }
    return base;
  },
  progress: (e) => `... ${String(e.data.message ?? "")}`,
  task_completed: (e) => `task ${e.taskId} completed`,
  task_failed: (e) =>
    `task ${e.taskId} FAILED [${String(e.data.code ?? "UNKNOWN_ERROR")}]: ${String(e.data.error ?? "")}`,
  review_result: (e) =>
    `review: ${String(e.data.decision ?? "")} ${String(e.data.notes ?? "")}`,
  context_compacted: (e) =>
    `context compacted (${String(e.data.beforeTokens ?? "?")} -> ${String(e.data.afterTokens ?? "?")} tokens)`,
  run_completed: (e) => `run ${e.runId} completed`,
  run_failed: (e) => `run ${e.runId} FAILED: ${String(e.data.error ?? "")}`,
  run_cancelled: (e) => `run ${e.runId} cancelled`,
  model_token: (e) => String(e.data.token ?? ""),
};

/** Attaches a human/JSON renderer to the bus. Returns an unsubscribe function. */
export function attachStreamRenderer(
  bus: EventBus,
  options: StreamOptions = {},
): () => void {
  const write =
    options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  return bus.onEvent((event) => {
    if (isVerboseEvent(event.type) && !options.verbose) return;
    if (options.quiet && QUIET_SUPPRESSED.has(event.type)) return;
    if (options.json) {
      write(JSON.stringify(event));
      return;
    }
    const formatter = HUMAN_SUMMARY[event.type];
    write(
      formatter
        ? formatter(event)
        : `${event.type} ${JSON.stringify(event.data)}`,
    );
  });
}

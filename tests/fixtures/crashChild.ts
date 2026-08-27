/**
 * Standalone script run as a child process by tests/integration/crashRecovery.test.ts.
 * Drives one run against a real on-disk SQLite database (not :memory:) so a
 * second, separate process can resume it after this one is killed.
 *
 * Env vars: STATE_DIR, WORKSPACE, RUN_ID, MODE ("start" | "resume")
 */
import { openDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { MockProvider } from "../../src/providers/mock.js";
import { runOrchestration } from "../../src/orchestration/runLoop.js";
import type { AgentLoopConfig } from "../../src/config/schema.js";

const stateDir = process.env.STATE_DIR!;
const workspace = process.env.WORKSPACE!;
const runId = process.env.RUN_ID!;
const mode = process.env.MODE ?? "start";

const config: AgentLoopConfig = {
  workspace,
  approvalMode: "all",
  reviewer: { provider: "mock", model: "m", auth: "api_key", apiKey: "unused" },
  developer: {
    provider: "mock",
    model: "m",
    auth: "api_key",
    apiKey: "unused",
  },
  contextTokenBudget: 100_000,
  maxReviewRounds: 1,
  stateDir,
};

const reviewer = new MockProvider((request) => {
  const isPlanCall = request.messages.some((m) =>
    m.content.includes("You are the Planner"),
  );
  if (isPlanCall) {
    return {
      content: JSON.stringify({
        tasks: [
          {
            id: "fast",
            description: "fast task",
            dependencies: [],
            risk: "low",
            acceptanceCriteria: [],
          },
          {
            id: "slow",
            description: "slow task",
            dependencies: [],
            risk: "low",
            acceptanceCriteria: [],
          },
        ],
      }),
    };
  }
  return { content: JSON.stringify({ decision: "approve", notes: "ok" }) };
});

const developer = new MockProvider((request) => {
  const last = request.messages[request.messages.length - 1]!.content;
  if (last.includes('"id":"slow"')) {
    // The parent test controls the sleep duration per phase: long for the
    // initial run (so a SIGKILL sent right after "command_started" reliably
    // lands mid-sleep regardless of process/tsx startup jitter), short for
    // the resumed run (which re-executes it from scratch, since "low" risk
    // commands are safe to blindly retry) so the test doesn't hang.
    const sleepSeconds = process.env.SLEEP_SECONDS ?? "1";
    return {
      content: JSON.stringify({
        actions: [{ type: "run_command", command: `sleep ${sleepSeconds}` }],
      }),
    };
  }
  return {
    content: JSON.stringify({
      actions: [{ type: "write_file", path: "fast-done.txt", content: "done" }],
    }),
  };
});

async function main() {
  const repository = new Repository(openDatabase(stateDir));
  const events = new EventBus();
  events.onEvent((e) => {
    // Signal readiness markers on stdout for the parent test to watch for.
    if (e.type === "command_started")
      process.stdout.write("MARKER:command_started\n");
    if (e.type === "task_completed" && e.taskId === "fast")
      process.stdout.write("MARKER:fast_completed\n");
  });

  await runOrchestration({
    runId,
    prompt: mode === "start" ? "crash recovery scenario" : undefined,
    config,
    repository,
    events,
    reviewerProvider: reviewer,
    developerProvider: developer,
    concurrency: 2,
  });
  process.stdout.write("MARKER:run_finished\n");
}

main().catch((error) => {
  process.stderr.write(`child error: ${(error as Error).message}\n`);
  process.exit(1);
});

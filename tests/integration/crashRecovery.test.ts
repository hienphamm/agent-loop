import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const childScript = path.join(repoRoot, "tests", "fixtures", "crashChild.ts");

interface ChildHandle {
  waitForMarker(marker: string, timeoutMs?: number): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
  waitForExit(): Promise<number | null>;
}

function spawnChild(env: Record<string, string>): ChildHandle {
  // Run tsx as an --import loader in-process (`node --import tsx script.ts`)
  // rather than via the `tsx` CLI binary: the CLI wrapper forks a *second*
  // real node process to do the actual work, so killing the wrapper's pid
  // does not kill (or even signal) the process actually running our code —
  // it would silently keep going to completion in the background. Using
  // the loader form means the pid we spawn is the pid doing the work, so
  // SIGKILL on it is an actual mid-execution crash.
  const child = spawn(process.execPath, ["--import", "tsx", childScript], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  const waiters: { marker: string; resolve: () => void }[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (const waiter of [...waiters]) {
      if (buffer.includes(`MARKER:${waiter.marker}`)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  return {
    waitForMarker(marker, timeoutMs = 15000) {
      if (buffer.includes(`MARKER:${marker}`)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for marker ${marker}`)),
          timeoutMs,
        );
        waiters.push({
          marker,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    kill(signal: NodeJS.Signals = "SIGKILL") {
      child.kill(signal);
    },
    waitForExit() {
      return exitPromise;
    },
  };
}

describe("crash recovery across real OS processes", () => {
  it("killed mid-command-execution: fast sibling task's completion survives, resume finishes the slow task without duplicating the fast one", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agent-loop-crash-state-"),
    );
    const workspace = mkdtempSync(path.join(tmpdir(), "agent-loop-crash-ws-"));
    mkdirSync(workspace, { recursive: true });
    const runId = "crash-test-run";

    const child1 = spawnChild({
      STATE_DIR: stateDir,
      WORKSPACE: workspace,
      RUN_ID: runId,
      MODE: "start",
      SLEEP_SECONDS: "20",
    });

    // Wait until we know a shell command is actually executing (the slow
    // task's `sleep`) AND its concurrent sibling has already finished,
    // then kill -9 the whole process — this is a crash *during* command
    // execution, not a graceful shutdown, with a completed sibling task
    // whose durability we can then check.
    await Promise.all([
      child1.waitForMarker("command_started"),
      child1.waitForMarker("fast_completed"),
    ]);
    child1.kill("SIGKILL");
    const exitCode = await child1.waitForExit();
    expect(exitCode).not.toBe(0); // it really was killed, not a clean finish

    // Inspect state left behind by the killed process, from a fresh
    // Repository instance (simulating "a completely new process looks
    // at this later").
    const repository1 = new Repository(openDatabase(stateDir));
    const runAfterCrash = repository1.getRun(runId);
    expect(runAfterCrash).toBeDefined();
    expect(runAfterCrash!.status).not.toBe("completed");
    const tasksAfterCrash = repository1.listTasks(runId);
    const fastAfterCrash = tasksAfterCrash.find((t) => t.id === "fast");
    // The fast task had no reason to be affected by the slow task's crash.
    expect(fastAfterCrash?.status).toBe("completed");
    expect(existsSync(path.join(workspace, "fast-done.txt"))).toBe(true);
    // The lock the crashed process held must not still look "alive" forever —
    // the pid really is dead, so a resume must be able to reclaim it.
    const lock = repository1.getRunLock(runId);
    expect(lock).toBeDefined();

    // Resume from a brand-new process against the same on-disk DB.
    const child2 = spawnChild({
      STATE_DIR: stateDir,
      WORKSPACE: workspace,
      RUN_ID: runId,
      MODE: "resume",
      SLEEP_SECONDS: "1",
    });
    await child2.waitForMarker("run_finished", 20000);
    const exitCode2 = await child2.waitForExit();
    expect(exitCode2).toBe(0);

    const repository2 = new Repository(openDatabase(stateDir));
    const finalRun = repository2.getRun(runId);
    expect(finalRun?.status).toBe("completed");
    const finalTasks = repository2.listTasks(runId);
    expect(finalTasks.find((t) => t.id === "fast")?.status).toBe("completed");
    expect(finalTasks.find((t) => t.id === "slow")?.status).toBe("completed");
    // Fast task's file was never re-written by a duplicate execution after resume.
    expect(readFileSync(path.join(workspace, "fast-done.txt"), "utf8")).toBe(
      "done",
    );
    // No stale lock left behind after a clean finish.
    expect(repository2.getRunLock(runId)).toBeUndefined();
  }, 30_000);
});

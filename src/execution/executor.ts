import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EventBus } from "../events/bus.js";
import type { Repository } from "../persistence/repository.js";
import { classifyCommand, type CommandRisk } from "./commandSafety.js";
import { assertWorkspaceRootValid, resolveWorkspacePath } from "./workspace.js";
import type { ApprovalGate } from "./approval.js";
import { WorkspaceSafetyError } from "../errors/index.js";
import { sanitizedChildEnv } from "../util/childEnv.js";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

export interface ExecutorOptions {
  dryRun?: boolean;
  /** Soft timeout: SIGTERM is sent after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Grace period after SIGTERM before escalating to SIGKILL. Default 5s. */
  killGraceMs?: number;
  /** Max combined stdout+stderr bytes kept before truncating and killing. Default 5MB. */
  maxOutputBytes?: number;
}

/** Risk categories where a crashed/unknown-outcome attempt must not be silently retried. */
const UNSAFE_TO_BLINDLY_RETRY: ReadonlySet<CommandRisk> = new Set([
  "destructive",
  "network",
]);

/**
 * The only component allowed to touch the filesystem or spawn processes on
 * behalf of the Developer/Executor role. Every action is confined to the
 * workspace root, classified for risk, and gated by approval before running.
 *
 * Enforcement boundary, precisely: this class validates and confines the
 * *paths it is directly told to touch* (file reads/writes, and the initial
 * `cwd` of a spawned command). It does NOT sandbox what an approved shell
 * command does once it starts — a command can still `cd` elsewhere, spawn
 * children, or reach the network. See commandSafety.ts for what that means.
 */
export class Executor {
  private readonly workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    private readonly runId: string,
    private readonly repository: Repository,
    private readonly events: EventBus,
    private readonly approvalGate: ApprovalGate,
    private readonly options: ExecutorOptions = {},
  ) {
    this.workspaceRoot = assertWorkspaceRootValid(workspaceRoot);
  }

  readFile(taskId: string, relPath: string): string {
    const abs = resolveWorkspacePath(this.assertWorkspaceStillValid(), relPath);
    return readFileSync(abs, "utf8");
  }

  async writeFile(
    taskId: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    // Validated once up front so path traversal fails fast even on a cache hit.
    resolveWorkspacePath(this.assertWorkspaceStillValid(), relPath);
    const idempotencyKey = hashKey(
      "write_file",
      this.runId,
      taskId,
      relPath,
      content,
    );

    const cached = this.checkCache(
      idempotencyKey,
      "write_file",
      relPath,
      taskId,
    );
    if (cached.skip) return;

    const approved = await this.approvalGate.requestApproval({
      runId: this.runId,
      taskId,
      scope: "task",
      summary: `write file ${relPath} (${content.length} bytes)`,
    });
    if (!approved) {
      throw new WorkspaceSafetyError(
        `Write to "${relPath}" was rejected by approval policy`,
      );
    }
    if (this.options.dryRun) {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "progress",
        data: { message: `[dry-run] would write ${relPath}` },
      });
      return;
    }

    this.repository.recordIdempotentAttempt(
      idempotencyKey,
      this.runId,
      taskId,
      "low",
    );
    // Re-validate immediately before the write: the workspace root or an
    // intermediate directory could have been replaced/relinked between the
    // check above and now (best-effort TOCTOU defense — see workspace.ts).
    const abs = resolveWorkspacePath(this.assertWorkspaceStillValid(), relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    this.repository.recordIdempotentResult(
      idempotencyKey,
      this.runId,
      taskId,
      "low",
      { path: relPath },
    );
  }

  async runCommand(
    taskId: string,
    command: string,
    cwd?: string,
  ): Promise<CommandResult> {
    const root = this.assertWorkspaceStillValid();
    const workingDir = cwd ? resolveWorkspacePath(root, cwd) : root;
    const classification = classifyCommand(command);

    const idempotencyKey = hashKey(
      "run_command",
      this.runId,
      taskId,
      command,
      cwd ?? "",
    );
    const cached = this.checkCache(
      idempotencyKey,
      "run_command",
      command,
      taskId,
      classification.risk,
    );
    if (cached.skip)
      return (
        (cached.result as CommandResult) ?? {
          exitCode: null,
          stdout: "",
          stderr: "",
        }
      );
    if (cached.requiresApprovalBeforeRetry) {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "progress",
        data: {
          message: `previous attempt of "${command}" crashed before its outcome was recorded (risk=${classification.risk}); requiring approval before retrying instead of silently re-running it`,
        },
      });
    }

    const approved = await this.approvalGate.requestApproval({
      runId: this.runId,
      taskId,
      scope: "task",
      summary: cached.requiresApprovalBeforeRetry
        ? `RETRY (outcome of previous attempt unknown): ${command}`
        : `run: ${command}`,
      classification,
      forceManual: cached.requiresApprovalBeforeRetry,
    });
    if (!approved) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "rejected by approval policy",
      };
    }

    this.events.emit({
      runId: this.runId,
      taskId,
      type: "command_started",
      data: { command, risk: classification.risk },
    });

    if (this.options.dryRun) {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "command_completed",
        data: { command, exitCode: 0, dryRun: true },
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    this.repository.recordIdempotentAttempt(
      idempotencyKey,
      this.runId,
      taskId,
      classification.risk,
    );
    const result = await this.spawnShell(command, workingDir);
    this.events.emit({
      runId: this.runId,
      taskId,
      type: "command_completed",
      data: {
        command,
        exitCode: result.exitCode,
        truncated: result.truncated ?? false,
      },
    });
    if (result.exitCode === 0) {
      this.repository.recordIdempotentResult(
        idempotencyKey,
        this.runId,
        taskId,
        classification.risk,
        result,
      );
    }
    return result;
  }

  createCheckpoint(taskId: string | undefined, description: string): void {
    this.repository.createCheckpoint({
      runId: this.runId,
      taskId,
      description,
    });
  }

  /** Re-checks the workspace root exists and hasn't been swapped since construction. */
  private assertWorkspaceStillValid(): string {
    return assertWorkspaceRootValid(this.workspaceRoot);
  }

  private checkCache(
    key: string,
    kind: "write_file" | "run_command",
    subject: string,
    taskId: string,
    risk: CommandRisk = "low",
  ): {
    skip: boolean;
    result?: unknown;
    requiresApprovalBeforeRetry?: boolean;
  } {
    const state = this.repository.getIdempotencyState(key);
    if (!state) return { skip: false };

    if (state.status === "completed") {
      this.events.emit({
        runId: this.runId,
        taskId,
        type: "progress",
        data: {
          message: `skip (already applied): ${kind === "write_file" ? `write ${subject}` : subject}`,
        },
      });
      return { skip: true, result: state.result };
    }

    // status === "attempted": a previous run started this and we never
    // learned the outcome (crash, kill -9, power loss). Re-running a
    // read-only/low-risk action is safe; re-running something classified
    // destructive/network could double-charge, double-post, or double-delete.
    if (UNSAFE_TO_BLINDLY_RETRY.has(risk)) {
      return { skip: false, requiresApprovalBeforeRetry: true };
    }
    return { skip: false };
  }

  private spawnShell(command: string, cwd: string): Promise<CommandResult> {
    const maxOutputBytes = this.options.maxOutputBytes ?? 5 * 1024 * 1024;
    const softTimeoutMs = this.options.timeoutMs ?? 10 * 60 * 1000;
    const killGraceMs = this.options.killGraceMs ?? 5000;

    return new Promise((resolve, reject) => {
      // shell: true is required so multi-command shell syntax (pipes,
      // redirects, &&) the Developer/Executor emits actually works; see
      // commandSafety.ts for what that trades away, and workspace.ts /
      // approval.ts for what still bounds it (approved paths, cwd, risk
      // gating). Secrets are stripped from the child's environment below.
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedChildEnv(),
      });

      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let truncated = false;
      let settled = false;
      let hardKillTimer: NodeJS.Timeout | undefined;
      const softTimer = setTimeout(() => {
        truncated = truncated || false;
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      }, softTimeoutMs);

      const appendCapped = (target: "stdout" | "stderr", chunk: Buffer) => {
        if (outputBytes >= maxOutputBytes) {
          if (!truncated) truncated = true;
          return;
        }
        const remaining = maxOutputBytes - outputBytes;
        const text = chunk.toString("utf8");
        const slice =
          Buffer.byteLength(text) > remaining
            ? chunk.subarray(0, remaining).toString("utf8")
            : text;
        outputBytes += Buffer.byteLength(slice);
        if (target === "stdout") stdout += slice;
        else stderr += slice;
        if (outputBytes >= maxOutputBytes) {
          truncated = true;
          // Output cap reached: stop the process rather than let it run
          // unbounded while we silently drop everything after this point.
          child.kill("SIGTERM");
          hardKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) =>
        appendCapped("stdout", chunk),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        appendCapped("stderr", chunk),
      );
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        resolve({ exitCode, stdout, stderr, truncated });
      });
    });
  }
}

function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join(" ")).digest("hex");
}

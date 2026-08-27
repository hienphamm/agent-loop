import { spawn } from "node:child_process";
import { ProviderError } from "../errors/index.js";
import { sanitizedChildEnv } from "../util/childEnv.js";
import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/**
 * Adapter for providers authenticated via their own CLI session (auth mode
 * "cli"). It shells out to a user-configured exec command, writes the
 * rendered prompt to stdin, and reads the completion from stdout. This
 * keeps the orchestration core provider-agnostic: any CLI that can read a
 * prompt on stdin and print a response on stdout works here.
 *
 * Hardening: the child's environment strips secret-shaped variables (this
 * process's own provider keys should never leak into an arbitrary CLI it
 * spawns), output is capped so a runaway/looping CLI can't exhaust memory,
 * and a hard timeout guarantees this never hangs the run forever.
 */
export class CliExecProvider implements ProviderAdapter {
  readonly name = "cli-exec";

  constructor(
    private readonly execCommand: string,
    private readonly options: {
      timeoutMs?: number;
      maxOutputBytes?: number;
    } = {},
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const prompt = request.messages
      .map((m) => `[${m.role}]\n${m.content}`)
      .join("\n\n");
    const [bin, ...args] = this.execCommand.split(" ");
    if (!bin)
      throw new ProviderError("cli-exec: empty exec command configured");

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes =
      this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise<CompletionResult>((resolve, reject) => {
      const child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizedChildEnv(),
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let hardKillTimer: NodeJS.Timeout | undefined;

      const softTimer = setTimeout(() => {
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeoutMs);

      const cap = (chunk: Buffer): string | undefined => {
        if (outputBytes >= maxOutputBytes) return undefined;
        const remaining = maxOutputBytes - outputBytes;
        const text = chunk.toString("utf8");
        const slice =
          Buffer.byteLength(text) > remaining
            ? chunk.subarray(0, remaining).toString("utf8")
            : text;
        outputBytes += Buffer.byteLength(slice);
        if (outputBytes >= maxOutputBytes) {
          child.kill("SIGTERM");
          hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        }
        return slice;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += cap(chunk) ?? "";
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += cap(chunk) ?? "";
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        reject(new ProviderError(`cli-exec failed to start: ${error.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        if (code !== 0) {
          reject(
            new ProviderError(
              `cli-exec exited with code ${code}: ${stderr.slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve({ content: stdout.trim() });
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

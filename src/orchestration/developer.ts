import type { ContextManager } from "../context/manager.js";
import type { Executor } from "../execution/executor.js";
import { ProviderError } from "../errors/index.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { Task } from "./types.js";

export type DeveloperAction =
  | { type: "run_command"; command: string; cwd?: string }
  | { type: "write_file"; path: string; content: string };

export interface DeveloperActionResult {
  action: DeveloperAction;
  output?: string;
  exitCode?: number | null;
}

/**
 * The Developer/Executor role. It asks the configured provider for a
 * structured list of actions, then hands each action to the Executor, which
 * enforces the workspace boundary and approval policy.
 */
export class DeveloperAgent {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly model: string,
    private readonly context: ContextManager,
    private readonly executor: Executor,
  ) {}

  async run(task: Task): Promise<DeveloperActionResult[]> {
    const actions = await this.planActions(task);
    const results: DeveloperActionResult[] = [];
    for (const action of actions) {
      if (action.type === "run_command") {
        const result = await this.executor.runCommand(
          task.id,
          action.command,
          action.cwd,
        );
        results.push({
          action,
          output: `${result.stdout}${result.stderr}`.slice(0, 4000),
          exitCode: result.exitCode,
        });
      } else {
        await this.executor.writeFile(task.id, action.path, action.content);
        results.push({ action });
      }
    }
    return results;
  }

  private async planActions(task: Task): Promise<DeveloperAction[]> {
    const system =
      "You are the Developer/Executor. Given one approved task, respond with JSON only: " +
      '{"actions":[{"type":"run_command","command":string,"cwd":string}|{"type":"write_file","path":string,"content":string}]}. ' +
      "Paths are always relative to the workspace root. Keep the action list minimal and directly tied to the task's acceptance criteria.";
    await this.context.addMessage({ role: "system", content: system });
    await this.context.addMessage({
      role: "user",
      content: JSON.stringify({
        id: task.id,
        description: task.description,
        scope: task.scope,
        acceptanceCriteria: task.acceptanceCriteria,
      }),
    });

    const result = await this.provider.complete({
      model: this.model,
      jsonMode: true,
      messages: this.context.getMessages(),
    });
    await this.context.addMessage({
      role: "assistant",
      content: result.content,
    });

    return parseActions(result.content);
  }
}

function parseActions(raw: string): DeveloperAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProviderError(
      `Developer did not return valid JSON: ${(error as Error).message}`,
      raw.slice(0, 300),
    );
  }
  const obj = parsed as { actions?: unknown };
  if (!Array.isArray(obj.actions)) {
    throw new ProviderError(
      "Developer response did not include an actions array",
    );
  }
  return (obj.actions as Record<string, unknown>[]).map((a) => {
    if (a.type === "write_file") {
      return {
        type: "write_file",
        path: String(a.path),
        content: String(a.content ?? ""),
      };
    }
    return {
      type: "run_command",
      command: String(a.command ?? ""),
      cwd: a.cwd ? String(a.cwd) : undefined,
    };
  });
}

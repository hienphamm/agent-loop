import type { ContextManager } from "../context/manager.js";
import type { Executor } from "../execution/executor.js";
import { ProviderError } from "../errors/index.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { Repository } from "../persistence/repository.js";
import {
  parseDeveloperResponse,
  type BlockedAction,
  type DoneAction,
  type StepAction,
} from "./actions.js";
import type { Task } from "./types.js";

export type { DeveloperAction, StepAction, BlockedReason } from "./actions.js";

/** Conservative default: enough for a real multi-step task, bounded so a stuck loop can't run forever. */
export const DEFAULT_MAX_DEVELOPER_ACTIONS = 25;
/** Default wall-time budget for one task's entire Developer loop (not per-action). */
export const DEFAULT_DEVELOPER_WALL_TIME_MS = 10 * 60 * 1000;

export interface DeveloperLoopLimits {
  maxActions: number;
  wallTimeMs: number;
}

export interface DeveloperActionResult {
  action: StepAction;
  output?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  entries?: { path: string; type: "file" | "directory" }[];
  matches?: { path: string; line: number; text: string }[];
  content?: string;
  truncated?: boolean;
}

export interface DeveloperDoneOutcome {
  status: "done";
  changedFiles: string[];
  requestedChecks: string[];
  skippedChecks: string[];
  blockers: string[];
  assumptions: string[];
  architecturalDecisions: string[];
}

export type DeveloperBlockedReason =
  | "MISSING_INFORMATION"
  | "ACCEPTANCE_CRITERIA_UNSATISFIABLE"
  | "REPEATED_COMMAND_FAILURE"
  | "APPROVAL_DENIED"
  | "OUT_OF_SCOPE"
  | "OTHER"
  | "ACTION_LIMIT_EXCEEDED"
  | "WALL_TIME_EXCEEDED";

export interface DeveloperBlockedOutcome {
  status: "blocked";
  reason: DeveloperBlockedReason;
  detail: string;
}

export interface DeveloperRunResult {
  actionResults: DeveloperActionResult[];
  outcome: DeveloperDoneOutcome | DeveloperBlockedOutcome;
}

/**
 * The Developer/Executor role. Runs a bounded, iterative tool loop: each
 * turn the provider requests exactly one typed action (or, for backward
 * compatibility, a one-shot `actions[]` list); the Executor runs it under
 * the workspace boundary and approval policy, and the sanitized result is
 * persisted and fed back into the same conversation before the next turn.
 * The loop ends when the Developer returns `DONE` or `BLOCKED`, or when the
 * configured action-count/wall-time budget is exceeded.
 *
 * Command/write evidence always comes from the Executor: a `run_command`
 * failure throws (same as before P2) and is never converted into a
 * Developer-reported success — `DONE`'s `changedFiles` etc. are the
 * Developer's own claims, recorded as-is for the Reviewer, not verified
 * here (independent reconciliation against a Git delta is P3 work).
 */
export class DeveloperAgent {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly model: string,
    private readonly context: ContextManager,
    private readonly executor: Executor,
    private readonly repository: Repository,
    private readonly limits: DeveloperLoopLimits = {
      maxActions: DEFAULT_MAX_DEVELOPER_ACTIONS,
      wallTimeMs: DEFAULT_DEVELOPER_WALL_TIME_MS,
    },
  ) {}

  async run(task: Task): Promise<DeveloperRunResult> {
    const deadline = Date.now() + this.limits.wallTimeMs;
    await this.context.addMessage({ role: "system", content: SYSTEM_PROMPT });
    await this.context.addMessage({
      role: "user",
      content: JSON.stringify(taskPayload(task)),
    });

    const actionResults: DeveloperActionResult[] = [];
    let seq = 0;

    for (;;) {
      if (Date.now() > deadline) {
        return {
          actionResults,
          outcome: {
            status: "blocked",
            reason: "WALL_TIME_EXCEEDED",
            detail: `Developer loop exceeded its ${this.limits.wallTimeMs}ms wall-time budget after ${seq} action(s).`,
          },
        };
      }
      if (seq >= this.limits.maxActions) {
        return {
          actionResults,
          outcome: {
            status: "blocked",
            reason: "ACTION_LIMIT_EXCEEDED",
            detail: `Developer loop exceeded its ${this.limits.maxActions}-action budget.`,
          },
        };
      }

      const raw = await this.callProvider();
      const parsed = parseResponse(raw);

      if (parsed.kind === "legacy") {
        // Backward-compatible one-shot path: run every action in the list,
        // then synthesize a DONE outcome — this is exactly what pre-P2
        // callers relied on (`{"actions": [...]}` executed in full, task
        // succeeds unless an action throws).
        for (const action of parsed.actions) {
          seq += 1;
          if (seq > this.limits.maxActions) {
            return {
              actionResults,
              outcome: {
                status: "blocked",
                reason: "ACTION_LIMIT_EXCEEDED",
                detail: `Developer loop exceeded its ${this.limits.maxActions}-action budget.`,
              },
            };
          }
          actionResults.push(await this.executeAction(task, action, seq));
        }
        return { actionResults, outcome: synthesizeLegacyDone(actionResults) };
      }

      const action = parsed.action;
      if (action.type === "done") {
        return { actionResults, outcome: toDoneOutcome(action) };
      }
      if (action.type === "blocked") {
        return { actionResults, outcome: toBlockedOutcome(action) };
      }

      seq += 1;
      const result = await this.executeAction(task, action, seq);
      actionResults.push(result);

      await this.context.addMessage({
        role: "user",
        content: JSON.stringify({ actionResult: result }),
      });
    }
  }

  private async executeAction(
    task: Task,
    action: StepAction,
    seq: number,
  ): Promise<DeveloperActionResult> {
    // Durability boundary: the request is persisted before it executes.
    this.repository.recordDeveloperActionRequest(
      task.runId,
      task.id,
      seq,
      action,
    );

    let result: DeveloperActionResult;
    try {
      result = await this.runAction(task, action);
    } catch (error) {
      // Persisted before the error propagates: even though this throws out
      // of the loop (matching P1's command-failure semantics — the
      // Executor's evidence, not a Developer claim, decides success), the
      // durable log still reflects that this action reached a known,
      // recorded outcome rather than being silently lost.
      this.repository.recordDeveloperActionResult(
        task.runId,
        task.id,
        seq,
        "failed",
        { message: (error as Error).message },
      );
      throw error;
    }

    // Persisted before the next model turn.
    this.repository.recordDeveloperActionResult(
      task.runId,
      task.id,
      seq,
      "completed",
      result,
    );
    return result;
  }

  private async runAction(
    task: Task,
    action: StepAction,
  ): Promise<DeveloperActionResult> {
    switch (action.type) {
      case "run_command": {
        const result = await this.executor.runCommand(
          task.id,
          action.command,
          action.cwd,
          action.expectedExitCodes,
        );
        return {
          action,
          output: `${result.stdout}${result.stderr}`.slice(0, 4000),
          exitCode: result.exitCode,
          signal: result.signal,
        };
      }
      case "write_file": {
        await this.executor.writeFile(task.id, action.path, action.content);
        return { action };
      }
      case "read_file": {
        const file = this.executor.readFile(task.id, action.path);
        return { action, content: file.content, truncated: file.truncated };
      }
      case "list_files": {
        const listed = this.executor.listFiles(
          task.id,
          action.path,
          action.maxResults,
        );
        return {
          action,
          entries: listed.entries,
          truncated: listed.truncated,
        };
      }
      case "search_text": {
        const searched = this.executor.searchText(task.id, action.query, {
          relDir: action.path,
          maxMatches: action.maxMatches,
          caseSensitive: action.caseSensitive,
        });
        return {
          action,
          matches: searched.matches,
          truncated: searched.truncated,
        };
      }
    }
  }

  private async callProvider(): Promise<string> {
    const result = await this.provider.complete({
      model: this.model,
      jsonMode: true,
      messages: this.context.getMessages(),
    });
    await this.context.addMessage({
      role: "assistant",
      content: result.content,
    });
    return result.content;
  }
}

const SYSTEM_PROMPT =
  "You are the Developer/Executor. Given one approved task, work iteratively: " +
  'respond with JSON only, either {"action": <ONE typed action>} to take the next step, ' +
  'or (legacy, still supported) {"actions": [<typed action>, ...]} to submit a full one-shot list. ' +
  "Typed actions: " +
  '{"type":"read_file","path":string}, ' +
  '{"type":"list_files","path"?:string,"maxResults"?:number}, ' +
  '{"type":"search_text","query":string,"path"?:string,"maxMatches"?:number,"caseSensitive"?:boolean}, ' +
  '{"type":"run_command","command":string,"cwd"?:string,"expectedExitCodes"?:number[]}, ' +
  '{"type":"write_file","path":string,"content":string}. ' +
  "After each action in the iterative protocol you will receive its sanitized result and must choose the next action. " +
  "Only unknown fields or an unknown action type are rejected — send exactly the documented fields. " +
  "Command success/failure is decided by the Executor's actual exit code, never by your own claim. " +
  'When the task is fully done, respond with {"action":{"type":"done","changedFiles":string[],"requestedChecks":string[],"skippedChecks":string[],"blockers":string[],"assumptions":string[],"architecturalDecisions":string[]}}. ' +
  'If you cannot proceed, respond with {"action":{"type":"blocked","reason":"MISSING_INFORMATION"|"ACCEPTANCE_CRITERIA_UNSATISFIABLE"|"REPEATED_COMMAND_FAILURE"|"APPROVAL_DENIED"|"OUT_OF_SCOPE"|"OTHER","detail":string}}. ' +
  "Paths are always relative to the workspace root. Keep actions minimal and directly tied to the task's acceptance criteria.";

function taskPayload(task: Task) {
  return {
    id: task.id,
    description: task.description,
    scope: task.scope,
    acceptanceCriteria: task.acceptanceCriteria,
  };
}

function parseResponse(raw: string) {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new ProviderError(
      `Developer did not return valid JSON: ${(error as Error).message}`,
      raw.slice(0, 300),
    );
  }
  return parseDeveloperResponse(parsedJson);
}

function toDoneOutcome(action: DoneAction): DeveloperDoneOutcome {
  return {
    status: "done",
    changedFiles: action.changedFiles,
    requestedChecks: action.requestedChecks,
    skippedChecks: action.skippedChecks,
    blockers: action.blockers,
    assumptions: action.assumptions,
    architecturalDecisions: action.architecturalDecisions,
  };
}

function toBlockedOutcome(action: BlockedAction): DeveloperBlockedOutcome {
  return { status: "blocked", reason: action.reason, detail: action.detail };
}

/**
 * Legacy `actions[]` callers never reported DONE metadata explicitly, so it
 * is synthesized from what actually ran: `changedFiles` from every
 * `write_file` action's path (the only claim backed by Executor evidence),
 * everything else empty. This is what "backward compatible" means here —
 * the legacy shape completes the task exactly as it always did.
 */
function synthesizeLegacyDone(
  actionResults: DeveloperActionResult[],
): DeveloperDoneOutcome {
  const changedFiles = actionResults
    .filter((r) => r.action.type === "write_file")
    .map((r) => (r.action as { path: string }).path);
  return {
    status: "done",
    changedFiles,
    requestedChecks: [],
    skippedChecks: [],
    blockers: [],
    assumptions: [],
    architecturalDecisions: [],
  };
}

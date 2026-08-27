import type { ContextManager } from "../context/manager.js";
import type { ProviderAdapter } from "../providers/types.js";
import { ProviderError } from "../errors/index.js";
import type { Plan, ReviewResult, Task, TaskSpec } from "./types.js";

/**
 * Planner and Reviewer are the same agent role operating in two phases, as
 * specified by the proposal: identical provider/model/context, distinct
 * JSON contracts per phase.
 */
export class PlannerReviewerAgent {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly model: string,
    private readonly context: ContextManager,
  ) {}

  async plan(prompt: string, agentsMdRules: string[]): Promise<Plan> {
    const rulesBlock = agentsMdRules.length
      ? `Applicable rules from AGENTS.md (must be honored as constraints):\n${agentsMdRules.map((r) => `- ${r}`).join("\n")}\n\n`
      : "";
    const system =
      "You are the Planner. Decompose the user's request into a JSON object: " +
      '{"tasks":[{"id":string,"description":string,"dependencies":string[],"scope":string,"risk":"low"|"medium"|"high","acceptanceCriteria":string[]}],"rationale":string}. ' +
      "Task ids must be unique. Dependencies must reference other task ids in this same plan. Respond with JSON only.";
    await this.context.addMessage({ role: "system", content: system });
    await this.context.addMessage({
      role: "user",
      content: `${rulesBlock}Request: ${prompt}`,
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

    return parsePlan(result.content);
  }

  async review(
    tasks: Task[],
    round: number,
    maxRounds: number,
  ): Promise<ReviewResult> {
    const system =
      "You are the Reviewer. Evaluate the executed tasks against their acceptance criteria. " +
      'Respond with JSON only: {"decision":"approve"|"request_changes"|"reject","notes":string,"followUpTasks":[...]} ' +
      "where followUpTasks (optional) use the same task schema as the planner. " +
      `This is review round ${round} of a maximum of ${maxRounds}; if this is the last round, prefer "approve" or "reject" over another revision cycle.`;
    const payload = tasks.map((t) => ({
      id: t.id,
      description: t.description,
      status: t.status,
      acceptanceCriteria: t.acceptanceCriteria,
      result: t.result,
      error: t.error,
    }));
    await this.context.addMessage({ role: "system", content: system });
    await this.context.addMessage({
      role: "user",
      content: JSON.stringify(payload),
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

    return parseReview(result.content);
  }
}

function parsePlan(raw: string): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProviderError(
      `Planner did not return valid JSON: ${(error as Error).message}`,
      raw.slice(0, 300),
    );
  }
  const obj = parsed as { tasks?: unknown; rationale?: unknown };
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    throw new ProviderError(
      "Planner response did not include a non-empty tasks array",
    );
  }
  const tasks: TaskSpec[] = obj.tasks.map(
    (t: Record<string, unknown>, index: number) => ({
      id: String(t.id ?? `task-${index + 1}`),
      description: String(t.description ?? ""),
      dependencies: Array.isArray(t.dependencies)
        ? t.dependencies.map(String)
        : [],
      scope: t.scope ? String(t.scope) : undefined,
      risk: (["low", "medium", "high"].includes(String(t.risk))
        ? t.risk
        : "low") as TaskSpec["risk"],
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
        ? t.acceptanceCriteria.map(String)
        : [],
    }),
  );
  return {
    tasks,
    rationale: obj.rationale ? String(obj.rationale) : undefined,
  };
}

function parseReview(raw: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProviderError(
      `Reviewer did not return valid JSON: ${(error as Error).message}`,
      raw.slice(0, 300),
    );
  }
  const obj = parsed as {
    decision?: unknown;
    notes?: unknown;
    followUpTasks?: unknown;
  };
  const decision = ["approve", "request_changes", "reject"].includes(
    String(obj.decision),
  )
    ? (obj.decision as ReviewResult["decision"])
    : "request_changes";
  const followUpTasks = Array.isArray(obj.followUpTasks)
    ? (obj.followUpTasks as Record<string, unknown>[]).map((t, index) => ({
        id: String(t.id ?? `followup-${index + 1}`),
        description: String(t.description ?? ""),
        dependencies: Array.isArray(t.dependencies)
          ? t.dependencies.map(String)
          : [],
        scope: t.scope ? String(t.scope) : undefined,
        risk: (["low", "medium", "high"].includes(String(t.risk))
          ? t.risk
          : "low") as TaskSpec["risk"],
        acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
          ? t.acceptanceCriteria.map(String)
          : [],
      }))
    : undefined;
  return { decision, notes: String(obj.notes ?? ""), followUpTasks };
}

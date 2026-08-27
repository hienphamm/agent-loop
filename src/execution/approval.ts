import { setTimeout as sleep } from "node:timers/promises";
import type { ApprovalMode } from "../config/schema.js";
import { ApprovalRequiredError } from "../errors/index.js";
import type { EventBus } from "../events/bus.js";
import type { Repository } from "../persistence/repository.js";
import type { ApprovalScope } from "../orchestration/types.js";
import type { CommandClassification } from "./commandSafety.js";

export interface ApprovalRequest {
  runId: string;
  taskId?: string;
  scope: ApprovalScope;
  summary: string;
  classification?: CommandClassification;
  /** Never auto-approve this request regardless of approval mode (e.g. a retry with an unknown prior outcome). */
  forceManual?: boolean;
}

export interface ApprovalGateOptions {
  pollIntervalMs?: number;
  /** Give up waiting after this long and leave the task blocked for a later `resume`. */
  waitTimeoutMs?: number;
  isCancelled?: () => boolean;
}

const AUTO_APPROVE_RISKS = new Set(["read_only", "low"]);

/**
 * Central approval gate. Every destructive operation, workspace-boundary
 * action, or network operation must be routed through `requestApproval`
 * before it executes.
 */
export class ApprovalGate {
  constructor(
    private readonly repository: Repository,
    private readonly events: EventBus,
    private readonly mode: ApprovalMode,
    private readonly options: ApprovalGateOptions = {},
  ) {}

  /** Resolves to true when execution may proceed, false when rejected. */
  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (this.autoApproves(request)) {
      const record = this.repository.createApproval({
        runId: request.runId,
        taskId: request.taskId,
        scope: request.scope,
        summary: request.summary,
      });
      this.repository.resolveApproval(record.id, "approved", "auto");
      this.events.emit({
        runId: request.runId,
        taskId: request.taskId,
        type: "approval_resolved",
        data: { decision: "approved", summary: request.summary, auto: true },
      });
      return true;
    }

    // Was this exact request already resolved before a crash? Reuse that
    // decision instead of creating a new approval nobody will ever answer —
    // see findApproval's docstring for why matching includes the summary.
    const priorDecision = this.repository.findApproval(
      request.runId,
      request.taskId,
      request.scope,
      request.summary,
    );
    if (priorDecision && priorDecision.status !== "pending") {
      return priorDecision.status === "approved";
    }

    const record =
      priorDecision ??
      this.repository.createApproval({
        runId: request.runId,
        taskId: request.taskId,
        scope: request.scope,
        summary: request.summary,
      });

    this.events.emit({
      runId: request.runId,
      taskId: request.taskId,
      type: "approval_required",
      data: {
        approvalId: record.id,
        summary: request.summary,
        scope: request.scope,
        risk: request.classification?.risk,
      },
    });

    return this.waitForResolution(record.id, request);
  }

  private autoApproves(request: ApprovalRequest): boolean {
    if (request.forceManual) return false;
    if (this.mode === "all") return true;
    if (this.mode === "safe") {
      const risk = request.classification?.risk ?? "low";
      return AUTO_APPROVE_RISKS.has(risk);
    }
    return false; // manual
  }

  private async waitForResolution(
    approvalId: string,
    request: ApprovalRequest,
  ): Promise<boolean> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    const deadline =
      Date.now() + (this.options.waitTimeoutMs ?? 24 * 60 * 60 * 1000);

    while (Date.now() < deadline) {
      if (this.options.isCancelled?.()) return false;
      const approvals = this.repository.listApprovals(request.runId);
      const current = approvals.find((a) => a.id === approvalId);
      if (current && current.status !== "pending") {
        this.events.emit({
          runId: request.runId,
          taskId: request.taskId,
          type: "approval_resolved",
          data: { decision: current.status, summary: request.summary },
        });
        return current.status === "approved";
      }
      await sleep(pollIntervalMs);
    }

    throw new ApprovalRequiredError(
      `Timed out waiting for approval on "${request.summary}"`,
      `Run \`agent-loop approve ${request.runId}${request.taskId ? ` --task ${request.taskId}` : ""}\` then \`agent-loop resume ${request.runId}\`.`,
    );
  }
}

export type TaskStatus =
  | "pending"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

export type TaskRisk = "low" | "medium" | "high";

export interface TaskSpec {
  id: string;
  description: string;
  dependencies: string[];
  scope?: string;
  risk: TaskRisk;
  acceptanceCriteria: string[];
}

export interface Task extends TaskSpec {
  runId: string;
  status: TaskStatus;
  retryCount: number;
  idempotencyKey?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  tasks: TaskSpec[];
  rationale?: string;
}

export type RunStatus =
  | "pending"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  id: string;
  prompt: string;
  workspace: string;
  status: RunStatus;
  currentConversationId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewDecision = "approve" | "request_changes" | "reject";

export interface ReviewResult {
  decision: ReviewDecision;
  notes: string;
  followUpTasks?: TaskSpec[];
}

export type ApprovalScope = "plan" | "task" | "risk_category";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRecord {
  id: string;
  runId: string;
  taskId?: string;
  scope: ApprovalScope;
  status: ApprovalStatus;
  summary: string;
  requestedAt: string;
  resolvedAt?: string;
  decidedBy?: string;
}

export interface RetryRecord {
  id: string;
  runId: string;
  taskId: string;
  attempt: number;
  error?: string;
  backoffMs: number;
  createdAt: string;
}

export type ConversationRole = "reviewer" | "developer";

export interface ConversationRecord {
  id: string;
  runId: string;
  role: ConversationRole;
  summary?: StructuredSummary;
  tokenCount: number;
  supersededBy?: string;
  createdAt: string;
}

export interface StructuredSummary {
  decisions: string[];
  facts: string[];
  rules: string[];
  artifacts: string[];
  openQuestions: string[];
}

export interface CheckpointRecord {
  id: string;
  runId: string;
  taskId?: string;
  description: string;
  ref?: string;
  createdAt: string;
}

export type MemoryKind = "decision" | "fact" | "rule" | "artifact";

export interface MemoryRecord {
  id: string;
  runId?: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
}

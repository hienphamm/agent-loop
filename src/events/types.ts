/**
 * Deterministic event schema shared by persistence, streaming, and logs.
 * Every event is keyed by runId (and taskId when applicable) and carries a
 * monotonically increasing sequence number assigned by the event bus.
 */

export type OperationalEventType =
  | "run_started"
  | "plan_ready"
  | "approval_required"
  | "approval_resolved"
  | "task_started"
  | "command_started"
  | "command_completed"
  | "progress"
  | "task_completed"
  | "task_failed"
  | "review_result"
  | "context_compacted"
  | "run_completed"
  | "run_failed"
  | "run_cancelled";

/** Opt-in only: raw provider token deltas. Never emitted unless --verbose-stream. */
export type VerboseEventType = "model_token";

export type EventType = OperationalEventType | VerboseEventType;

export interface BaseEvent {
  seq: number;
  runId: string;
  taskId?: string;
  type: EventType;
  timestamp: string; // ISO-8601
  data: Record<string, unknown>;
}

export function isVerboseEvent(type: EventType): type is VerboseEventType {
  return type === "model_token";
}

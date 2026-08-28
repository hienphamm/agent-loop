import { z } from "zod";
import { ActionValidationError } from "../errors/index.js";

/**
 * Strict, typed Developer action protocol (P2 slice 1).
 *
 * Every action schema uses `.strict()` so an unrecognized field is rejected
 * rather than silently ignored, and the discriminated union rejects an
 * unrecognized `type` outright. Validation happens here, before any
 * Executor call, so a malformed action can never reach the filesystem,
 * approval gate, or a spawned process.
 */

const KNOWN_ACTION_TYPES = [
  "read_file",
  "list_files",
  "search_text",
  "run_command",
  "write_file",
  "done",
  "blocked",
] as const;

export const ExpectedExitCodesSchema = z
  .array(z.number().int().min(0).max(255))
  .min(1)
  .optional();

export const ReadFileActionSchema = z
  .object({
    type: z.literal("read_file"),
    path: z.string().min(1),
  })
  .strict();
export type ReadFileAction = z.infer<typeof ReadFileActionSchema>;

export const ListFilesActionSchema = z
  .object({
    type: z.literal("list_files"),
    path: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict();
export type ListFilesAction = z.infer<typeof ListFilesActionSchema>;

export const SearchTextActionSchema = z
  .object({
    type: z.literal("search_text"),
    query: z.string().min(1),
    path: z.string().optional(),
    maxMatches: z.number().int().positive().optional(),
    caseSensitive: z.boolean().optional(),
  })
  .strict();
export type SearchTextAction = z.infer<typeof SearchTextActionSchema>;

export const RunCommandActionSchema = z
  .object({
    type: z.literal("run_command"),
    command: z.string().min(1),
    cwd: z.string().optional(),
    expectedExitCodes: ExpectedExitCodesSchema,
  })
  .strict();
export type RunCommandAction = z.infer<typeof RunCommandActionSchema>;

export const WriteFileActionSchema = z
  .object({
    type: z.literal("write_file"),
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();
export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

/**
 * Machine-readable BLOCKED reasons. `OTHER` exists so a Developer is never
 * forced to misuse an unrelated reason for a genuinely uncategorized block,
 * but the free-text `detail` is required on every reason so BLOCKED is
 * always actionable, not just a bare label.
 */
export const BlockedReasonSchema = z.enum([
  "MISSING_INFORMATION",
  "ACCEPTANCE_CRITERIA_UNSATISFIABLE",
  "REPEATED_COMMAND_FAILURE",
  "APPROVAL_DENIED",
  "OUT_OF_SCOPE",
  "OTHER",
]);
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

export const DoneActionSchema = z
  .object({
    type: z.literal("done"),
    changedFiles: z.array(z.string()),
    requestedChecks: z.array(z.string()),
    skippedChecks: z.array(z.string()),
    blockers: z.array(z.string()),
    assumptions: z.array(z.string()),
    architecturalDecisions: z.array(z.string()),
  })
  .strict();
export type DoneAction = z.infer<typeof DoneActionSchema>;

export const BlockedActionSchema = z
  .object({
    type: z.literal("blocked"),
    reason: BlockedReasonSchema,
    detail: z.string().min(1),
  })
  .strict();
export type BlockedAction = z.infer<typeof BlockedActionSchema>;

/** Non-terminal action a single iterative Developer turn can request. */
export const StepActionSchema = z.discriminatedUnion("type", [
  ReadFileActionSchema,
  ListFilesActionSchema,
  SearchTextActionSchema,
  RunCommandActionSchema,
  WriteFileActionSchema,
]);
export type StepAction = z.infer<typeof StepActionSchema>;

/** Any single action, including the two terminal ones. */
export const DeveloperActionSchema = z.discriminatedUnion("type", [
  ReadFileActionSchema,
  ListFilesActionSchema,
  SearchTextActionSchema,
  RunCommandActionSchema,
  WriteFileActionSchema,
  DoneActionSchema,
  BlockedActionSchema,
]);
export type DeveloperAction = z.infer<typeof DeveloperActionSchema>;

/** Legacy one-shot response: `{"actions": [...]}`, no terminal actions inside. */
export const LegacyActionsResponseSchema = z
  .object({
    actions: z.array(StepActionSchema),
  })
  .strict();

/** New iterative response: exactly one action (including DONE/BLOCKED) per turn. */
export const SingleActionResponseSchema = z
  .object({
    action: DeveloperActionSchema,
  })
  .strict();

export type DeveloperResponse =
  | { kind: "legacy"; actions: StepAction[] }
  | { kind: "single"; action: DeveloperAction };

function actionTypeOf(raw: unknown): string | undefined {
  if (typeof raw === "object" && raw !== null && "type" in raw) {
    const t = (raw as Record<string, unknown>).type;
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

function toActionValidationError(
  raw: unknown,
  error: z.ZodError,
): ActionValidationError {
  const type = actionTypeOf(raw);
  const isUnknownType =
    type === undefined ||
    !(KNOWN_ACTION_TYPES as readonly string[]).includes(type);
  const issues = error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  const hasUnrecognizedKeys = error.issues.some(
    (i) => i.code === "unrecognized_keys",
  );

  if (isUnknownType) {
    return new ActionValidationError(
      `Unknown or missing action type${type ? ` "${type}"` : ""}`,
      `action.type must be one of: ${KNOWN_ACTION_TYPES.join(", ")}.`,
      { validationCode: "UNKNOWN_ACTION_TYPE", details: issues },
    );
  }
  return new ActionValidationError(
    `Malformed "${type}" action: ${issues.join("; ")}`,
    "Fix the listed fields; only the documented fields for this action type are accepted.",
    {
      validationCode: hasUnrecognizedKeys
        ? "UNKNOWN_FIELD"
        : "MALFORMED_ACTION",
      details: issues,
    },
  );
}

/**
 * Same idea as {@link toActionValidationError}, but for a failure inside the
 * legacy `actions[]` array: the failing element must be located via the
 * first issue's path (its leading array index) rather than assumed to be
 * the top-level response object, or every legacy validation error would be
 * misreported as an unknown top-level action type.
 */
function toLegacyActionValidationError(
  actions: readonly unknown[],
  error: z.ZodError,
): ActionValidationError {
  const firstIssue = error.issues[0];
  const index = firstIssue?.path.find(
    (segment): segment is number => typeof segment === "number",
  );
  const offending = index !== undefined ? actions[index] : undefined;
  return toActionValidationError(offending, error);
}

/**
 * Parses one raw JSON-decoded Developer turn into either the legacy
 * `actions[]` shape or the new single-`action` shape. Throws
 * {@link ActionValidationError} on anything else — including a response
 * that has neither `actions` nor `action`, or has both.
 */
export function parseDeveloperResponse(parsed: unknown): DeveloperResponse {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ActionValidationError(
      "Developer response must be a JSON object",
      'Respond with {"action": {...}} or, for legacy callers, {"actions": [...]}.',
      { validationCode: "MALFORMED_ACTION" },
    );
  }
  const obj = parsed as Record<string, unknown>;
  const hasActions = "actions" in obj;
  const hasAction = "action" in obj;

  if (hasActions && hasAction) {
    throw new ActionValidationError(
      'Developer response must include exactly one of "action" or "actions", not both',
      'Use {"action": {...}} for the iterative protocol, or {"actions": [...]} for the legacy one-shot protocol.',
      { validationCode: "MALFORMED_ACTION" },
    );
  }

  if (hasActions) {
    const result = LegacyActionsResponseSchema.safeParse(obj);
    if (!result.success) {
      const rawActions = Array.isArray((obj as { actions?: unknown }).actions)
        ? (obj as { actions: unknown[] }).actions
        : [];
      throw toLegacyActionValidationError(rawActions, result.error);
    }
    return { kind: "legacy", actions: result.data.actions };
  }

  if (hasAction) {
    const result = SingleActionResponseSchema.safeParse(obj);
    if (!result.success) {
      throw toActionValidationError(
        (obj as { action?: unknown }).action,
        result.error,
      );
    }
    return { kind: "single", action: result.data.action };
  }

  throw new ActionValidationError(
    'Developer response did not include "action" or "actions"',
    'Respond with {"action": {...}} or {"actions": [...]}.',
    { validationCode: "MISSING_FIELD" },
  );
}

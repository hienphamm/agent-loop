# Agent Loop Implementation Roadmap

## Objective

Evolve `@hienphamm/agent-loop` from a hardened MVP into a production-ready local orchestration package that can safely replace the custom Reviewer/Developer loop currently embedded in `orchestration-engine`.

The roadmap is ordered by dependency and adoption value. Each phase should remain independently releasable, backward-compatible where practical, and covered by focused unit and integration tests.

## Current Baseline

### P1 — Command Failure and Idempotency Semantics — Completed

P1 established reliable command-result semantics and removed the possibility that a failed command silently completes a task.

Delivered outcomes:

- Exit code `0` is required by default.
- Callers can explicitly configure `expectedExitCodes`.
- Unexpected exits, signals, timeouts, spawn failures, and approval rejection use stable structured errors.
- Failed commands participate in task retry policy correctly.
- Idempotency identity includes normalized expected exit codes.
- Known failures are distinguished from unknown outcomes after interruption.
- Diagnostics are bounded and redacted.
- Unit, integration, typecheck, lint, build, and package tests pass.

P1 is the safety baseline for every later phase and should not be weakened.

## Planned Phases

### P2 — Iterative Developer Tool Loop and Typed Actions — Slice 1 delivered

#### Slice 1 status (this delivery)

Delivered:

- Strict, typed action schemas for `read_file`, `list_files`, `search_text`,
  `run_command`, `write_file`, and the terminal `done`/`blocked` actions.
  Unknown action types and unknown fields are rejected before any
  filesystem mutation, approval prompt, or process spawn, via stable
  `ActionValidationError` `validationCode`s (`UNKNOWN_ACTION_TYPE`,
  `UNKNOWN_FIELD`, `MALFORMED_ACTION`, `MISSING_FIELD`) and a `details` list.
- A bounded, iterative Developer loop: one action per provider turn, its
  sanitized result persisted and fed back into the same conversation,
  continuing until `done`/`blocked` or a configured budget is exceeded.
- Executor read-only actions (`read_file`, `list_files`, `search_text`),
  workspace-boundary/symlink-escape protected like `write_file`, bounded
  (result count, matches, bytes read/scanned), deterministic, and redacted
  before being persisted or fed back to the provider. `search_text` is a
  literal, pure-JS substring search — no shell invocation.
- `done` requires `changedFiles`, `requestedChecks`, `skippedChecks`,
  `blockers`, `assumptions`, and `architecturalDecisions`; `blocked`
  requires a machine-readable `reason` and a `detail` string. A
  `run_command` action's success/failure is still decided solely by the
  Executor's actual exit code — a Developer can never claim a command
  succeeded.
- `maxDeveloperActions` (default 25) and `developerActionWallTimeMs`
  (default 10 minutes) bound one task's loop; exceeding either produces a
  durable `blocked` outcome, never an infinite loop.
- Each action request is persisted before execution and each result before
  the next model turn, in a new `developer_actions` table added via
  `CREATE TABLE IF NOT EXISTS` (backward-compatible with an existing
  `state.db` — no ALTER needed).
- The legacy one-shot `{"actions": [...]}` response remains fully
  supported and tested: every action runs, then the task completes as if a
  `done` had been returned, `changedFiles` derived from the `write_file`
  actions that ran.
- All P1 command-failure/idempotency guarantees (exit-code semantics,
  retry policy, redaction, approval gating) are unchanged and re-verified.

Explicitly deferred (not in this slice):

- **`apply_patch`**: not implemented. Non-trivial edits still go through
  `write_file` (full-file replacement).
- **Full crash-mid-task resume**: the `developer_actions` log makes each
  action's request/result durable, and the Executor's existing idempotency
  keys prevent replaying a completed `write_file`/`run_command` side
  effect. What is **not** yet implemented: reconstructing a crashed task's
  in-flight provider conversation — a resumed task starts a fresh Developer
  conversation for that task rather than continuing mid-turn. This is the
  target for slice 2.
- **Token budgets**: out of scope, per the roadmap's own deferral note —
  the provider interface does not yet expose reliable token accounting for
  a per-turn/per-loop budget.
- **Richer per-turn output budgets**: `read_file`/`search_text` have fixed,
  conservative byte/match caps; a configurable per-action output budget is
  deferred.
- **Independent verification of `done`'s claims**: `changedFiles` etc. are
  recorded as the Developer's own claims, not reconciled against an actual
  Git delta — that reconciliation is P3 scope.

#### Goal

Replace the current one-shot `actions[]` response with a bounded, resumable tool loop that lets the Developer inspect, edit, verify, and correct its work before returning a terminal task result.

#### Problem

The current Developer receives one task and returns one complete action list. It cannot inspect command output and decide the next action within the same task turn. Its file protocol only supports full-file replacement, making non-trivial repository changes expensive and error-prone.

#### Scope

- Add typed actions for `read_file`, `list_files`, `search_text`, and `apply_patch`.
- Keep `write_file` and `run_command` backward-compatible.
- Add strict action schemas with unknown-field rejection and actionable validation errors.
- Execute one action at a time and return the sanitized result to the same Developer conversation.
- Continue until the Developer returns `DONE` or `BLOCKED`.
- Add configurable action-count, wall-time, token, and output budgets.
- Persist every action request/result before the next model turn.
- Resume an interrupted task from the last durable action boundary without replaying completed side effects.
- Require terminal results to report changed files, requested checks, skipped checks, blockers, assumptions, and architectural decisions.
- Prevent the Developer from declaring command success; command evidence must come from the Executor.

#### Acceptance Criteria

- A Developer can inspect a file, apply a patch, run a focused check, observe a failure, fix it, and complete the task in one durable loop.
- Completed actions are not repeated after crash/resume.
- Malformed actions fail before filesystem mutation, approval, or process execution.
- Loops terminate deterministically on configured budgets.
- Existing one-shot callers remain supported or receive a documented migration path.

### P3 — Git-Aware Task Ownership, Delta Reconciliation, and Verification

#### Goal

Make task completion evidence trustworthy enough for use in a dirty monorepo and for adoption by `orchestration-engine`.

#### Problem

The current Reviewer receives task action results but not a reconciled Git delta, immutable task baseline, or independently executed verification manifest. A task can therefore report completion without proving exactly which files changed or whether unrelated user work was preserved.

#### Scope

- Capture an immutable baseline per task: HEAD, index, tracked changes, untracked files, and content identities.
- Separate task `allowedPaths` from prose instructions and acceptance criteria.
- Reject overlapping ownership across concurrently executable tasks.
- Reconcile Developer-reported files against the actual task-scoped delta.
- Preserve pre-existing user changes and identify unauthorized modifications.
- Detect and restore real Git-index mutation while preserving working-tree changes.
- Introduce typed verification requests for focused tests, typecheck, lint, schema validation, and allowlisted custom checks.
- Run verification through the orchestrator, not through Developer claims.
- Persist exit code, signal, timeout, bounded output, and cache identity for every check.
- Cache only passed checks and invalidate them using relevant content identities.
- Give Reviewer the task contract, reconciled patch, file manifest, skipped conditional checks, and trusted verification evidence.

#### Acceptance Criteria

- Reviewer PASS is impossible without reconciled changed files and successful trusted evidence for unconditional checks.
- A task cannot modify a pre-existing dirty file unless its contract explicitly owns that path.
- Two tasks cannot silently own the same file or nested directory scope.
- Passed unchanged checks are reused after a fix; affected checks rerun.
- The feature works in both Git and explicitly documented non-Git modes.

### P4 — Durable Review Recovery and Non-Crashing Workflow State Machine

#### Goal

Ensure every recoverable provider, protocol, verification, review, and process failure becomes durable workflow state instead of terminating the CLI and requiring the original prompt again.

#### Scope

- Persist explicit phase and resume-phase checkpoints for planning, implementation, verification, review, approval, and completion.
- Add deterministic protocol-correction turns for malformed Planner, Developer, and Reviewer JSON.
- Preserve the latest valid task result when correcting result metadata.
- Resume timed-out provider sessions with compact durable context.
- Feed recoverable policy violations back to the responsible agent.
- Distinguish code findings from unavailable conditional prerequisites.
- Add bounded review epochs with Reviewer rotation.
- Return durable `BLOCKED` state on non-convergence instead of throwing a review-limit exception.
- Preserve review findings, required changes, resolved findings, verification evidence, and task baselines across restarts.
- Make cancellation interrupt or terminate active child processes safely, not only stop between tasks.

#### Acceptance Criteria

- Ctrl-C, provider timeout, malformed output, or process restart can resume without repeating completed Developer work.
- A final permitted fix is always reviewed before a limit decision.
- Conditional environment checks do not become impossible Developer code findings.
- Review non-convergence is visible as `BLOCKED` with actionable state and a zero-crash recovery path.
- `status` explains exactly what is running, waiting, failed, or resumable.

### P5 — Enforced Execution Isolation and Policy Profiles

#### Goal

Reduce the blast radius of model-generated commands from “approved shell running as the user” to an enforceable, configurable local execution boundary.

#### Scope

- Introduce an execution-backend interface.
- Keep the current local-shell backend as an explicit trusted mode.
- Add a sandboxed backend using an available OS/container mechanism.
- Enforce workspace mounts, network policy, environment allowlists, resource limits, and child-process cleanup.
- Replace shell strings with argv execution where shell syntax is unnecessary.
- Require explicit shell mode for pipes, redirects, substitutions, and compound commands.
- Add configurable command allow/deny policies and per-project policy profiles.
- Record the effective backend and policy decision in every command event.
- Add adversarial tests for traversal, symlink changes, shell obfuscation, network access, environment leakage, and runaway subprocess trees.

#### Acceptance Criteria

- Sandboxed mode prevents writes outside the workspace even after a command is approved.
- Network-disabled mode blocks outbound access rather than merely labeling it risky.
- Secret-shaped parent environment variables are not inherited.
- Timeout and cancellation terminate the complete subprocess tree.
- Users can clearly distinguish trusted-local and sandboxed execution modes.

### P6 — Observability, Cost Control, and Operator DX

#### Goal

Make long-running workflows understandable and economical without inspecting SQLite or process tables manually.

#### Scope

- Add phase/task/action timestamps, durations, attempts, and current activity to `status`.
- Track provider calls, estimated and reported tokens, verification duration, cache hits, retries, and approval wait time.
- Add concise live progress with stable event codes.
- Add `status --json`, `inspect`, and machine-readable failure summaries.
- Add `retry`, `replan`, `unblock`, and `archive` commands with explicit semantics.
- Add run history retention and cleanup policy.
- Produce human-readable plan and summary artifacts derived from SQLite state.
- Add provider output capture limits with tail preservation and protocol sentinels.
- Add configurable session rotation and compact durable summaries.
- Improve configuration discovery, diagnostics, and `doctor` output.

#### Acceptance Criteria

- An operator can identify the active phase, elapsed time, last checkpoint, current child process, and blocking condition from one command.
- JSON output remains pure and stable for automation.
- Long provider output cannot exhaust memory or discard the terminal protocol result.
- Run artifacts can be archived or cleaned without corrupting active state.
- Performance data can distinguish model time, verification time, approval wait, and orchestration overhead.

### P7 — Provider Reliability and Capability Negotiation

#### Goal

Make provider behavior explicit and portable across direct APIs and authenticated CLIs.

#### Scope

- Define provider capabilities for JSON schema enforcement, streaming, sessions, resume, tool calls, token usage, and cancellation.
- Add native adapters for the first supported CLI providers instead of relying only on generic shell configuration.
- Implement strict structured-output extraction and bounded correction.
- Preserve and resume provider-native session identifiers where supported.
- Add rate-limit handling, retry-after support, fallback routing, and circuit-breaking.
- Add contract tests that every provider adapter must pass.
- Add redaction tests for provider errors and raw streamed output.

#### Acceptance Criteria

- Unsupported provider capabilities fail during startup or downgrade explicitly.
- Session-capable providers resume without replaying full history.
- Malformed structured output has a bounded recovery path.
- Auth, rate-limit, timeout, and provider-unavailable failures have stable classifications.

### P8 — `orchestration-engine` Adoption and Compatibility Layer

#### Goal

Replace the custom `tools/agent-orchestrator` runtime with `@hienphamm/agent-loop` without losing its proven safety and recovery behavior.

#### Scope

- Document a feature-parity matrix between both tools.
- Add compatibility adapters for existing task contracts, typed checks, task baselines, review findings, and summary artifacts.
- Import or resume an existing `.agent/session.json` workflow where feasible, or provide an explicit one-time migration command.
- Reproduce the PR1–PR4 workflow scenarios as adoption fixtures.
- Validate dirty-worktree preservation, control-plane ownership, index restoration, verification caching, provider timeout recovery, malformed protocol recovery, and conditional checks.
- Add an opt-in project configuration for `orchestration-engine`.
- Run both implementations in shadow/dry-run mode and compare plans, actions, evidence, and terminal state.
- Remove the custom orchestrator only after parity and rollback criteria pass.

#### Acceptance Criteria

- The package completes a representative cross-package feature in `orchestration-engine` without touching unrelated changes.
- All existing orchestrator regression scenarios pass through the package API or compatibility layer.
- Resume does not require the original prompt to be entered again.
- A rollback path to the existing tool remains documented during migration.
- The adoption change does not weaken approval, verification, redaction, or Git safety guarantees.

## Recommended Delivery Order

```text
P1 completed
  -> P2 iterative tool loop
  -> P3 trusted Git delta and verification
  -> P4 durable recovery state machine
  -> P5 enforced isolation
  -> P6 observability and DX
  -> P7 provider reliability
  -> P8 orchestration-engine adoption
```

P2 through P4 form the minimum functional parity milestone for a controlled `orchestration-engine` pilot. P5 and the essential parts of P6 are recommended before enabling autonomous or approval-mode `all` execution on valuable repositories.

## Cross-Cutting Engineering Requirements

- Preserve P1 command-failure and idempotency semantics.
- Keep schemas versioned and migrations backward-compatible.
- Use stable machine-readable error and event codes.
- Redact secrets before logging, persistence, provider feedback, and terminal output.
- Keep tests deterministic and avoid live-provider requirements in the default suite.
- Prefer focused tests first; run broader package checks only before release handoff.
- Document skipped environment-dependent validation explicitly.
- Never mark a run complete solely because an agent returned a success-shaped payload.
- Every terminal state must be derivable from persisted evidence.

## Release Milestones

### Milestone A — Reliable Coding Loop

Includes P2 and P3. Suitable for local pilot usage with manual approval and a trusted execution environment.

### Milestone B — Recoverable Production Workflow

Includes P4, the essential status telemetry from P6, and migration tests. Suitable for long-running repository tasks without manual prompt reconstruction.

### Milestone C — Safe Autonomous Operation

Includes P5, full P6, and P7. Suitable for carefully configured autonomous runs inside an enforced sandbox.

### Milestone D — `orchestration-engine` Default

Includes P8 and a documented rollback window. The package becomes the default orchestration runtime only after parity tests pass.

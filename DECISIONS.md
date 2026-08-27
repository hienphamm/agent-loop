# Implementation decisions

The proposal (`collaborative-agents-cli-proposal.md`) intentionally left a
"Decisions required before implementation" section open, plus a number of
smaller ambiguities encountered while building the MVP. This file records
what was decided and why, so future changes can be made consistently.

## From "Decisions required before implementation"

- **First providers/protocol**: OpenAI (Chat Completions) and Anthropic
  (Messages API) via plain `fetch`, plus a `mock` provider for tests/dry-run.
  No SDK dependency — keeps the provider surface small and fully mockable.
- **Git mandatory?**: No. The workspace boundary and safety checks work on
  any directory; Git-specific commands are only special-cased for risk
  classification (e.g. `git reset --hard`, `git push --force`).
- **Default approval mode**: `manual`. Safety over convenience by default;
  `safe` and `all` are opt-in via `--approval-mode` or `.env`.
- **Network commands denied by default?**: Not denied, but classified as a
  distinct `network` risk category and treated like "not auto-approved"
  under `safe` mode (only `read_only`/`low` risk auto-approves under `safe`).
- **Context compaction threshold**: 80% of the configured token budget
  (`AGENT_LOOP_CONTEXT_TOKEN_BUDGET`, default 100,000).
- **Max review/retry rounds**: 3 review rounds by default
  (`AGENT_LOOP_MAX_REVIEW_ROUNDS`); 3 attempts per task for retries
  (`DEFAULT_RETRY_POLICY` in `src/orchestration/retry.ts`), exponential
  backoff starting at 1s, capped at 30s.
- **Provider CLI login flows first supported**: none built-in by name.
  Instead, `auth=cli` is generic: the user configures
  `*_CLI_CHECK_COMMAND` (exit 0 = logged in), `*_CLI_LOGIN_COMMAND` (shown as
  a remedy), and `*_CLI_EXEC_COMMAND` (a command that reads a rendered
  prompt on stdin and prints a completion on stdout). This works with
  `codex login` / `codex exec`-style CLIs without hardcoding any provider's
  CLI shape into the orchestration core.
- **Provider-specific API key env vars mapped by default**: `OPENAI_API_KEY`
  (openai), `ANTHROPIC_API_KEY` (anthropic), `GOOGLE_API_KEY` (google, adapter
  not yet implemented), `AGENT_LOOP_MOCK_API_KEY` (mock). See
  `PROVIDER_API_KEY_ENV` in `src/config/schema.ts`.

## Other implementation decisions

- **Planner/Reviewer conversations are per-phase, not one long-lived
  conversation.** Each call to `plan()` / `review()` creates a fresh
  `ContextManager` conversation seeded from durable memory rather than
  carrying forward the exact prior transcript. This trades a small amount of
  in-phase continuity for much simpler resume semantics: resuming a crashed
  run never has to reconstruct an in-flight conversation object, only the
  persisted plan/task/approval state.
- **Concurrency is batch-based, not a fully dynamic scheduler.** Tasks run in
  topologically-ordered batches (`TaskDag.topologicalBatches` /
  `readyTasks`), with up to `--concurrency` tasks per batch running in
  parallel. This is simpler and fully deterministic to test, at the cost of
  not maximizing parallelism across independent chains of different depths.
- **Approval waiting is poll-based against SQLite, not IPC.** `agent-loop
  run`/`resume` blocks on a pending approval by polling the `approvals`
  table (default every 1s) until `agent-loop approve` (a separate process)
  resolves it, or a 24h timeout elapses and the task is left `blocked` for a
  later `resume`. This keeps the whole system single-database and
  process-agnostic, matching "local-only, CLI-first."
- **Cancellation is DB-status-based.** `agent-loop cancel <runId>` sets the
  run's persisted status to `cancelled`; a running `run`/`resume` process
  notices at the next safe checkpoint (between tasks, or while polling for
  approval) and exits. `SIGINT`/`SIGTERM` to the process itself sets a local
  flag that has the same effect immediately.
- **Idempotency keys are content-hash based**
  (`sha256(kind, runId, taskId, command|path, content|cwd)`), not
  explicit ids returned by the model. Re-running the same task with the
  same resulting action is therefore automatically a no-op; a *different*
  action for a retried task is not skipped.
- **AGENTS.md is parsed as bullets + `key: value` directives**, not
  freeform Markdown semantics. Bullets become plan-visible constraints
  (concatenated in precedence order: global → workspace → subdirectories).
  Directives are compared by key across sources; differing values for the
  same key are reported as a conflict instead of one silently winning.
- **SQLite via `node:sqlite`** (Node ≥22.5, no native module / node-gyp
  build step), not `better-sqlite3`. Chosen to keep `npm install` fully
  native-toolchain-free. Loaded through `createRequire` in
  `src/persistence/db.ts` because static `import "node:sqlite"` isn't yet
  reliably resolved by every bundler/test runner.
- **`exactOptionalPropertyTypes` is off**, other `strict` flags are on.
  With it on, essentially every `T | undefined` optional field in the domain
  model needed an explicit `| undefined` annotation for no safety benefit
  in this codebase's style (optional fields are already `?`-marked
  everywhere they're optional).
- **The Developer/Executor's action protocol is intentionally minimal**:
  `run_command` and `write_file` only (no `read_file` action, no multi-step
  tool loop). This is enough to implement and verify the required safety
  properties (workspace boundary, approval gating, idempotency) end to end;
  a richer action set (patches, multi-file edits, `read_file` as a
  first-class action) is a natural next increment, not a redesign.

## Hardening pass: bugs found and fixed

A dedicated security/correctness review after the initial MVP found and
fixed several real defects (not just "recommendations" — all of these are
fixed in the code, with regression tests):

- **Events were never persisted.** `EventBus` emitted events, but nothing
  ever wrote them into the `events` table — `agent-loop logs` from a
  separate process always returned empty, and post-crash forensics had
  nothing to read. Fixed by subscribing `repository.appendEvent` inside
  `runOrchestration` itself (the one place that actually drives a run,
  regardless of caller). While fixing this, found and fixed a second bug in
  the same area: `appendEvent` used the in-memory `EventBus`'s per-process
  `seq` counter as the SQLite primary key, which collides the moment a
  second process (a second run, or a `resume`) also emits event #1. `seq`
  is now assigned by SQLite's own AUTOINCREMENT.
- **Resume could get permanently stuck in `planning`.** A crash between
  "status set to planning" and "status set to awaiting_approval" left a run
  in a status `resume` never checked for. Fixed: `planning` is now treated
  like `pending` for resume purposes (safe, since nothing is persisted
  until the plan is fully validated).
- **A plan approval granted while the process was down was ignored on
  resume.** `ApprovalGate` only looked for a *pending* approval before
  creating a new one; if the existing approval had already been resolved
  (via `agent-loop approve` while the run process was crashed/stopped),
  resume created a brand-new pending approval that nobody would ever
  answer, hanging until the 24h timeout. Fixed via `Repository.findApproval`
  (matches on the exact runId+taskId+scope+summary tuple, any status) —
  an already-resolved matching request is honored immediately instead of
  re-asked. Matching on the literal summary text (not just scope/task) is
  deliberate: it's what stops an old resolved approval for a *different*
  command against the same task from being silently reused later.
- **Concurrent tasks in the same batch shared one `ContextManager`.**
  `executePhase` built one conversation/agent for the whole phase and reused
  it across all tasks in a batch; with `--concurrency > 1`, two tasks
  running concurrently raced on the same mutable message array and token
  count across `await` points, risking one task's payload leaking into
  another's provider call. Fixed by constructing a fresh `ContextManager`/
  `DeveloperAgent` per task.
- **`approve`/`resolveApproval` had no compare-and-set.** Two racing
  `agent-loop approve` invocations (or an approve landing after a timeout
  already gave up) could silently overwrite each other's decision with
  last-write-wins. Fixed: `resolveApproval` is now `UPDATE ... WHERE status
  = 'pending'`, returns whether it actually won, and the CLI reports
  `APPROVAL_ALREADY_RESOLVED` instead of pretending it won.
- **No protection against two processes driving the same run.** Nothing
  stopped two `agent-loop run`/`resume` invocations against the same run id
  from racing on task/approval state. Added a `run_locks` table
  (`Repository.tryAcquireRunLock`/`releaseRunLock`): a run is locked to one
  holder for its duration; a dead holder's lock (checked via
  `process.kill(pid, 0)`) is reclaimed automatically so this only blocks
  genuinely concurrent drivers, not a legitimate resume after a crash.
  Locking compares by a unique per-call holder id, not just pid, so it also
  catches two concurrent calls from the *same* OS process.
- **Idempotency cache hid an unsafe-retry hazard.** The original design
  cached a result only after success, meaning a crash mid-command left no
  record at all, so a resume would blindly re-run it — fine for
  `read_only`/`low` risk, unsafe for `destructive`/`network` risk (e.g. a
  payment call) where the real-world outcome of the crashed attempt is
  unknown. Fixed: `recordIdempotentAttempt` is written *before* execution;
  on resume, an `attempted`-but-not-`completed` record for a
  destructive/network action forces a fresh, non-auto-approvable approval
  (`forceManual`) instead of silently retrying.
- **Command execution had no output cap or hard-kill escalation, and
  forwarded this process's full environment (including provider API keys)
  into every spawned command.** Fixed: stdout+stderr are capped (default
  5MB, process killed if exceeded), the soft timeout now escalates to
  SIGKILL after a grace period if SIGTERM doesn't stop it, and the child
  environment strips any secret-shaped variable
  (`API_KEY`/`SECRET`/`TOKEN`/`PASSWORD`/`AUTHORIZATION`) before spawning —
  applied to `run_command`, the `cli-exec` provider adapter, and shared via
  `src/util/childEnv.ts`.
- **Errors could leak secrets on the way out.** `toDisplayError`, the
  top-level `program.parseAsync().catch()`, and (new) `uncaughtException`/
  `unhandledRejection` handlers now all run every message/hint through
  `redact()` before printing — an underlying library echoing a secret back
  into its own error text no longer bypasses redaction.
- **HTTP provider calls had no timeout and no retryable/non-retryable
  classification.** `OpenAiProvider`/`AnthropicProvider` now use an
  `AbortController` with a timeout (default 120s), and `ProviderError`
  carries an explicit `retryable` flag: 401/403/400 are not retried; 429
  and 5xx are. `isRetryableError` honors this instead of retrying every
  provider failure identically.
- **`--json` mode wasn't pure JSON.** `agent-loop run` printed a
  human-readable `run id: ...` line to stdout even with `--json` set,
  which breaks any consumer piping stdout into a JSON parser. Fixed to only
  print that line outside `--json` (the `run_started` event already
  carries the run id in JSON mode).
- **No `--quiet` mode existed** despite being an expected CLI ergonomic.
  Added: suppresses `progress`/`command_started`/`command_completed`/
  `task_started`/`task_completed`/`context_compacted`/`model_token`, keeps
  run-lifecycle, approval, and failure events.
- **`classifyCommand` didn't flag `cd`-then-continue or git working-tree
  overrides.** A command like `cd .. && rm something-outside` classified as
  merely `low` risk. Added patterns for `cd` targeting outside the current
  directory and for `--git-dir`/`--work-tree`/`GIT_DIR=` overrides —
  still just a risk label surfaced for approval, not enforcement (see the
  Security limitations section in README.md for why enforcement isn't
  possible here without a real sandbox).

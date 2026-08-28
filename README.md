# agent-loop

CLI-first, local-only orchestrator for a two-role agent workflow:

- **Planner/Reviewer** — same agent role, two phases: plans a prompt into a
  task DAG, later reviews executed results and can request revisions.
- **Developer/Executor** — executes approved tasks inside a workspace you
  configure, with a strict path/command safety boundary.

No hosted service, no web UI, no remote database. State lives in a local
SQLite file under `.agent-loop/`.

## Install

```bash
npm install
npm run build
npm link   # or: node dist/cli/main.js ...
```

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no
native build step needed).

## Configure

```bash
cp .env.example .env
```

Edit `.env` for your project:

```dotenv
AGENT_LOOP_REVIEWER_PROVIDER=anthropic
AGENT_LOOP_REVIEWER_MODEL=claude-sonnet-5
AGENT_LOOP_REVIEWER_AUTH=api_key
AGENT_LOOP_REVIEWER_API_KEY=

AGENT_LOOP_DEVELOPER_PROVIDER=openai
AGENT_LOOP_DEVELOPER_MODEL=gpt-model
AGENT_LOOP_DEVELOPER_AUTH=api_key
AGENT_LOOP_DEVELOPER_API_KEY=

AGENT_LOOP_WORKSPACE=./project
AGENT_LOOP_APPROVAL_MODE=manual
```

Precedence (lowest to highest): built-in defaults → `.env` → process
environment → CLI flags (`--reviewer-provider`, `--workspace`, etc.).
Invalid or missing required configuration fails fast with an actionable
error, e.g.:

```
Error [CONFIG_INVALID]: Invalid configuration:
  - reviewer.model: model must not be empty
Hint: Check your .env file against .env.example, or pass the missing values as CLI flags.
```

`agent-loop` never commits `.env` for you, but it warns if `.gitignore`
doesn't appear to exclude it.

### Reviewer vs. Developer/Executor

They're configured independently — different provider, model, and auth mode
are all supported (`AGENT_LOOP_REVIEWER_*` / `AGENT_LOOP_DEVELOPER_*`, or
`--reviewer-*` / `--developer-*` flags).

## Authentication

Two modes, set explicitly per role — **there is no silent fallback between
them**.

### 1. Provider CLI login (`*_AUTH=cli`)

```bash
codex login                 # however your provider's CLI authenticates
agent-loop auth check
```

Configure how `agent-loop` talks to that session:

```dotenv
AGENT_LOOP_REVIEWER_AUTH=cli
AGENT_LOOP_REVIEWER_CLI_CHECK_COMMAND=codex login status   # must exit 0 when logged in
AGENT_LOOP_REVIEWER_CLI_LOGIN_COMMAND=codex login           # shown as the fix when not
AGENT_LOOP_REVIEWER_CLI_EXEC_COMMAND=codex exec             # reads a prompt on stdin, prints the completion on stdout
```

No API key is read, required, or stored for this role.

### 2. Direct API key (`*_AUTH=api_key`)

```dotenv
AGENT_LOOP_REVIEWER_AUTH=api_key
AGENT_LOOP_REVIEWER_API_KEY=sk-...
```

Provider-specific fallbacks are also recognized when the role-specific key
is unset: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.

Check what's configured, and actively verify it:

```bash
agent-loop auth status   # shows mode/provider/model per role, no secrets, no network calls
agent-loop auth check    # actively verifies the session/key per role
```

Secrets are registered for redaction the moment they're read and are never
written to logs, events, error messages, or `.agent-loop/state.db`.

## CLI

```bash
agent-loop run "Implement feature X" \
  --workspace ./project \
  --approval-mode manual

agent-loop status                # list recent runs
agent-loop status <run-id>       # full detail: tasks, approvals, checkpoints
agent-loop approve <run-id>                    # approve the plan
agent-loop approve <run-id> --task <task-id>   # approve one task's action
agent-loop approve <run-id> --reject           # reject instead
agent-loop cancel <run-id>
agent-loop logs <run-id> --follow
agent-loop resume <run-id>       # after a crash/Ctrl-C, or after approving offline
```

Flags available on `run`/`resume`: `--json` (newline-delimited JSON events
only — nothing else is ever written to stdout in this mode, for
scripts/CI), `--verbose-stream` (opt-in raw model tokens; off by default),
`--quiet` (suppress nonessential events — progress lines, per-command/task
start/stop — while keeping run-lifecycle and approval/failure events),
`--dry-run` (plan and log actions without touching the filesystem or
spawning processes), `--concurrency <n>` (parallel tasks per DAG batch,
default 2).

Only one `run`/`resume` process may drive a given run at a time — a second
one fails fast with `RUN_LOCKED` (a dead holder's lock is reclaimed
automatically, so this only blocks genuinely concurrent processes, not a
resume after a crash).

### Approval modes

- `manual` (default): every task-level action needs `agent-loop approve`.
- `safe`: read-only/low-risk actions auto-approve; destructive or
  network-classified actions still require `agent-loop approve`.
- `all`: everything auto-approves, but every action is still recorded in
  the audit trail (`agent-loop logs`).

### Streaming events

Default output is a small set of operational events:
`run_started`, `plan_ready`, `approval_required`, `approval_resolved`,
`task_started`, `command_started`, `command_completed`, `progress`,
`task_completed`, `task_failed`, `review_result`, `context_compacted`,
`run_completed` / `run_failed` / `run_cancelled`. Raw model tokens
(`model_token`) are only emitted with `--verbose-stream`.

### `run_command` exit-code semantics

A `run_command` action succeeds only when the process's actual exit code is
one of its `expectedExitCodes` — **`[0]` by default**. Any other outcome
(unexpected exit code, termination by signal, timeout, spawn failure, or
rejection by approval policy) fails the action with a stable, structured
error and fails the current task attempt — it never gets silently treated as
a completed task.

```ts
// Default: only a clean exit(0) counts as success.
{ type: "run_command", command: "npm test" }

// Intentionally accept a non-zero exit, e.g. a linter that uses exit 1 to
// mean "found issues, not a crash":
{ type: "run_command", command: "eslint .", expectedExitCodes: [0, 1] }
```

`expectedExitCodes`, when provided, must be a non-empty array of integers in
`0..255` (an empty array is rejected rather than silently matching every
exit code); duplicates are normalized away. An invalid value throws
`ActionValidationError` (`code: "INVALID_ACTION"`) before the command is ever
run.

A failed `run_command` action throws `CommandFailureError`, which carries
structured, machine-readable fields — not just a human-readable message:

```ts
{
  code: "UNEXPECTED_EXIT_CODE", // | "TERMINATED_BY_SIGNAL" | "COMMAND_TIMEOUT"
                                 // | "COMMAND_SPAWN_FAILED" | "APPROVAL_REJECTED"
  actualExitCode: 1,
  expectedExitCodes: [0],
  signal: null,
  timedOut: false,
  runId: "...",
  taskId: "...",
}
```

This failure goes through the same retry policy as any other task failure
(exponential backoff, 3 attempts by default — see below), **except**
`APPROVAL_REJECTED`: an explicit approval rejection is a deliberate policy
decision, not a transient failure, so it fails the task attempt immediately
instead of re-prompting for the same rejected command up to 3 times. Both
the `command_completed` and `task_failed`/`progress` events carry the same
structured fields, so reviewer evidence and `agent-loop logs` never depend on
parsing English text to know a command failed.

## Developer tool loop and typed actions (P2)

The Developer/Executor runs a bounded, iterative tool loop: each turn the
provider requests **exactly one** typed action, the Executor runs it, and the
sanitized result is persisted and fed back into the same conversation before
the next turn. The loop ends when the Developer returns `done` or `blocked`,
or when a configured budget is exceeded.

```json
{"action": {"type": "read_file", "path": "src/index.ts"}}
{"action": {"type": "list_files", "path": "src", "maxResults": 200}}
{"action": {"type": "search_text", "query": "TODO", "path": "src", "caseSensitive": false}}
{"action": {"type": "run_command", "command": "npm test", "expectedExitCodes": [0]}}
{"action": {"type": "write_file", "path": "src/index.ts", "content": "..."}}
{"action": {"type": "done", "changedFiles": ["src/index.ts"], "requestedChecks": ["npm test"], "skippedChecks": [], "blockers": [], "assumptions": [], "architecturalDecisions": []}}
{"action": {"type": "blocked", "reason": "MISSING_INFORMATION", "detail": "no target file was specified"}}
```

**Backward compatibility**: the pre-P2 one-shot shape,
`{"actions": [<typed action>, ...]}` (no `done`/`blocked` inside the list), is
still fully supported — every action in the list runs, then the task
completes as if a `done` had been returned, with `changedFiles` derived from
the `write_file` actions that ran. Existing callers require no changes.

**Read-only actions** (`read_file`, `list_files`, `search_text`) are
confined to the workspace boundary exactly like `write_file`/`run_command`
(traversal and symlink-escape rejected), bounded (result count, matches,
bytes read/scanned — see `execution/executor.ts` for the exact limits), and
redacted before being persisted, logged, or sent back to the provider.
`search_text` is a literal (non-regex) substring search implemented in pure
JS — it never invokes a shell.

**Validation**: every action is validated by a strict schema (unknown action
types and unknown fields are rejected) *before* any filesystem mutation,
approval prompt, or process spawn. A malformed action throws
`ActionValidationError` with a `validationCode` of `UNKNOWN_ACTION_TYPE`,
`UNKNOWN_FIELD`, `MALFORMED_ACTION`, or `MISSING_FIELD`, plus a `details`
array of the specific issues.

**Command evidence**: a `run_command` action's success/failure is decided
solely by the Executor's actual exit code (same semantics as before P2) — a
Developer can never report a command as having succeeded; `done`'s
`changedFiles`/checks fields are the Developer's own claims, recorded as-is
for the Reviewer (independent reconciliation against a Git delta is P3 work).

**Limits**: `maxDeveloperActions` (default 25) and
`developerActionWallTimeMs` (default 10 minutes, for the whole task loop, not
per action) bound the loop. Exceeding either produces a durable `blocked`
outcome (`reason: "ACTION_LIMIT_EXCEEDED"` / `"WALL_TIME_EXCEEDED"`) — never
an infinite loop. Configure via `AGENT_LOOP_MAX_DEVELOPER_ACTIONS` /
`AGENT_LOOP_DEVELOPER_ACTION_WALL_TIME_MS`, or the `maxDeveloperActions`/
`developerActionWallTimeMs` config fields (both optional; omitted means the
conservative defaults apply).

**Durability**: each action request is persisted (`developer_actions` table)
before it executes, and each result is persisted before the next model turn.
This is a genuinely new SQLite table, added via `CREATE TABLE IF NOT EXISTS`
— an existing `state.db` gains it automatically on next open, no migration
step required.

**Slice-1 scope and deferred work** (tracked in `ROADMAP.md`):
`apply_patch`, full crash-mid-task resume of the provider conversation, token
budgets, and richer per-turn output budgets are **not** part of this slice.
What *is* durable today: the action request/result log itself, and — via the
Executor's existing idempotency keys — real replay protection for
`write_file`/`run_command` (a repeated identical request after a crash is a
no-op, not a double execution). What resume does **not** yet do: reconstruct
a crashed task's in-flight provider conversation — a resumed task starts a
fresh Developer conversation for that task rather than continuing mid-turn.

## Resume, retry, and idempotency

- Every run, task, approval, retry, conversation, and checkpoint is
  persisted to `.agent-loop/state.db` (SQLite) as it happens.
- If the process is killed (crash, Ctrl-C, `kill`), `agent-loop resume
  <run-id>` picks up exactly where it left off: completed tasks are not
  re-run, in-progress state is re-derived from the database.
- Side-effecting actions (`write_file`, `run_command`) are keyed by a
  content hash of what they'd do — for `run_command`, that hash includes the
  command, `cwd`, **and** the normalized `expectedExitCodes`, so the same
  command under two different exit-code policies (e.g. `[0]` vs `[0, 1]`) is
  a different identity and can never share a cached result. `[1, 0, 1]` and
  `[0, 1]` normalize to the same identity; omitting `expectedExitCodes`
  behaves identically to passing `[0]` explicitly.
- A `run_command` idempotency row settles into one of three terminal-ish
  states: **completed** (succeeded; the cached result is returned and the
  action is never repeated), **failed** (ran to a *known* non-success —
  unexpected exit code, signal, timeout, or spawn failure — with a bounded,
  redacted diagnostic persisted; safe to just run again, since the outcome
  is already certain), or **attempted** (the process died mid-execution, so
  its real-world outcome is unknown). An **attempted** action is safe to
  re-run automatically if it's `read_only`/`low` risk; if it's
  `destructive`/`network` risk, `agent-loop` refuses to silently retry it
  and instead raises a fresh approval (`RETRY (outcome of previous attempt
  unknown): ...`) — see "Idempotency guarantees" below. A **failed** action
  is never treated as this unknown-outcome case, regardless of risk: it just
  re-runs like a fresh action, and the normal task retry policy decides
  whether to keep trying.
- An approval that was granted (or rejected) *while the process was down*
  is honored on resume instead of being asked again — resuming never
  creates a second, unanswerable approval request for the exact same action.
- Failed tasks retry automatically (exponential backoff, 3 attempts by
  default) unless the failure is a safety/config/auth/action-validation
  error, a provider error explicitly classified non-retryable (e.g. a
  401/403 auth failure or a 400 bad request), or a `run_command` failure
  whose reason is `APPROVAL_REJECTED` — those are never retried, since
  retrying can't help.

### Idempotency guarantees, precisely

- **Guarantee**: the same `write_file`/`run_command` action (same task,
  same content/command/cwd, and — for `run_command` — the same normalized
  `expectedExitCodes`) is never executed twice once it has completed
  successfully once, across any number of crashes/resumes.
- **Not guaranteed**: that the *command itself* is idempotent in the real
  world. `agent-loop` cannot know whether `curl -X POST .../charge` is safe
  to repeat — it only knows whether *it* already ran that exact command to
  completion for that exact task. If a command's outcome is unknown (crash
  mid-flight) and it's classified `destructive`/`network` risk, a human
  approval is required before it's tried again, specifically to put a
  person in the loop for exactly this ambiguity.

## Security limitations

- The Executor is confined to the configured `--workspace` for the paths it
  directly touches (file reads/writes, the `cwd` of a spawned command):
  path traversal (`../`), absolute paths outside the root, and symlinks
  (including nested ones) that resolve outside the root are all rejected,
  re-checked immediately before every write to reduce (not eliminate) a
  TOCTOU race, and re-checked if the workspace directory itself disappears
  or is replaced mid-run (`src/execution/workspace.ts`).
- **This is not a sandbox, and command risk classification
  (`src/execution/commandSafety.ts`) is a warning/audit label, not
  enforcement.** Once a shell command is approved, it runs with your OS
  user's full privileges: it can `cd` elsewhere, reach the network, spawn
  children, or do anything else your shell could do. The classifier flags
  common destructive patterns (`rm -rf`, `git reset --hard`, `cd ..`
  followed by more commands, etc.) and network-looking commands
  (`curl`/`wget`/`npm install`/...) to gate them behind approval in `safe`
  mode, but it cannot see through obfuscation (variables, command
  substitution, base64, etc.) and does not claim to. Treat every approval —
  especially under `--approval-mode safe`/`all` — as "I trust this command
  to run as me."
- `run_command` executes via a shell (`spawn(..., { shell: true })`) so the
  model-provided command string can use shell syntax (pipes, redirects).
  This is a deliberate compatibility tradeoff, mitigated by: risk
  classification + approval gating above; a stripped child environment
  (API keys/secrets are never forwarded into a spawned command's env, so
  `env`/`printenv` can't exfiltrate them); a bounded output buffer (default
  5MB, the process is killed if exceeded, so a runaway command can't exhaust
  memory); and a hard timeout (default 10 minutes: SIGTERM, then SIGKILL
  after a grace period if it doesn't exit, so a hung command can't block a
  run forever). Only run `agent-loop` against workspaces and providers you
  trust — none of this is a substitute for running it under an
  account/container with a limited blast radius.
- `--approval-mode all` disables human approval entirely (except a forced
  retry of an unknown-outcome destructive/network action, which is never
  auto-approved regardless of mode). It still writes a full audit trail,
  but nothing else blocks execution — use it only in disposable/sandboxed
  workspaces.
- Only one process may drive a given run at a time (`run_locks` table); a
  second concurrent `run`/`resume` on the same run id fails with
  `RUN_LOCKED` rather than racing on task/approval state.
- Secrets are redacted at every output boundary: registered the moment
  they're read (before any provider call), stripped from event data, error
  messages/hints (including the top-level uncaught-exception/unhandled-
  rejection handlers), and anything persisted to `.agent-loop/state.db`.

## Troubleshooting

- **"Invalid configuration" on startup** — compare your `.env` against
  `.env.example`; the error lists exactly which fields are missing/invalid.
- **`auth check` fails for `cli` mode** — run the printed `fix:` command
  (your configured `*_CLI_LOGIN_COMMAND`), then retry.
- **A run seems stuck** — check `agent-loop status <run-id>`: it's likely
  waiting on a pending approval (listed under "pending approvals"). Run
  `agent-loop approve <run-id>` (add `--task <id>` for a task-level one).
- **Process was killed mid-run** — `agent-loop resume <run-id>`.
- **Need to abort** — `agent-loop cancel <run-id>` from another terminal, or
  Ctrl-C the running process (both stop at the next safe point, not
  mid-command).

## Development

```bash
npm run typecheck
npm run lint
npm run format
npm test
```

Package layout: `src/{cli,config,auth,providers,orchestration,execution,
persistence,context,events,agentsMd,errors}`. See `DECISIONS.md` for the
implementation decisions made where the original proposal was
underspecified.

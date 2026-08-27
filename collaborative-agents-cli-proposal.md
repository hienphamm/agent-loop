# Proposal: `agent-loop`

## Objective

Build a local-only npm package and CLI that coordinates one AI agent through two distinct roles:

- **Planner/Reviewer**: analyzes requests, creates plans, validates results, and requests revisions.
- **Executor**: executes approved tasks inside a user-defined workspace.

The package supports interactive CLI usage, scripts, valuable streaming events, durable state, context compaction, and recovery after process termination.

## Scope and principles

- CLI-first and local-only; no hosted service or required remote backend.
- A small TypeScript API may support scripting, but the primary interface is the CLI.
- The Executor can read, write, and run shell/code only inside the configured workspace.
- Planner and Reviewer use the same agent/provider/model, but operate in separate phases with separate contracts.
- Reviewer and Developer/Executor may use different providers and models, configured through project settings.
- Authentication supports both provider CLI login sessions and direct API keys.
- Streaming exposes valuable operational events by default, not every raw model token.
- Every meaningful action is represented in persistent state and audit logs.
- Runs are resumable after crashes, termination, or transient provider failures.

## Core workflow

```text
User prompt
  -> Load AGENTS.md and previous state
  -> Plan and decompose into subtasks
  -> Review the plan
  -> Approval gate
  -> Execute subtasks
  -> Review diffs and results
  -> Revise or complete
  -> Checkpoint and summarize
```

When context approaches its token budget, the system persists a structured summary and starts a new conversation without losing decisions, constraints, task state, or artifacts.

## Proposed CLI

```bash
agent-loop run "Implement feature X" \
  --workspace ./project \
  --provider openai \
  --model gpt-model \
  --approval-mode safe

agent-loop resume <run-id>
agent-loop status <run-id>
agent-loop approve <run-id> --task task-2
agent-loop cancel <run-id>
agent-loop logs <run-id> --follow
```

## Project configuration and authentication

Each project may contain a `.env` file for provider, model, authentication, and execution settings. The file should be loaded from the project/workspace root and must never be committed to source control. The package should provide a `.env.example` template and warn when secrets appear to be tracked by Git.

Example:


```dotenv
AGENT_LOOP_REVIEWER_PROVIDER=openai
AGENT_LOOP_REVIEWER_MODEL=gpt-review-model
AGENT_LOOP_REVIEWER_AUTH=cli

AGENT_LOOP_DEVELOPER_PROVIDER=anthropic
AGENT_LOOP_DEVELOPER_MODEL=claude-code-model
AGENT_LOOP_DEVELOPER_AUTH=api_key
AGENT_LOOP_DEVELOPER_API_KEY=replace-me

AGENT_LOOP_WORKSPACE=./project
AGENT_LOOP_APPROVAL_MODE=manual
```

The role name **Developer** refers to the execution role and may be exposed in the CLI as **Executor** for consistency with the runtime terminology.

### Authentication case 1: provider CLI login

The user authenticates through the provider's own CLI, for example:

```bash
codex login
agent-loop auth status
```

The package then invokes the provider CLI or its local authenticated session according to a provider adapter. No API key is stored in the project `.env` file. The adapter must verify that the session exists before a run starts and provide a clear login command when authentication is missing or expired.

This mode is intended for providers whose official CLI manages authentication, session refresh, permissions, and model access.

### Authentication case 2: direct API key

The user places the API key in an environment variable, preferably supplied by the shell, a local secrets manager, or an ignored `.env` file:

```dotenv
AGENT_LOOP_REVIEWER_AUTH=api_key
AGENT_LOOP_REVIEWER_API_KEY=...
AGENT_LOOP_DEVELOPER_AUTH=api_key
AGENT_LOOP_DEVELOPER_API_KEY=...
```

Provider-specific environment variables may also be supported, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, through an explicit mapping in provider configuration.

Security requirements:

- Never print API keys in logs, errors, streaming events, or persisted state.
- Redact secrets from command output and diagnostic reports.
- Prefer process environment or a secrets manager over plaintext `.env` values.
- Validate `.gitignore` before creating or using a project `.env` file.
- Support `agent-loop auth check` without exposing secret values.
- Make authentication mode explicit; do not silently fall back from CLI login to an API key or vice versa.

Approval modes:

- `manual`: ask the user at approval gates.
- `safe`: automatically approve read-only and explicitly allowlisted operations.
- `all`: automatically approve all operations while still recording an audit trail.

## Ten additional feature groups

### 1. Persistent state and checkpoints

Persist runs, plans, tasks, conversation IDs, approvals, outputs, errors, retry counts, and workspace checkpoints. SQLite should be the default storage, with a storage adapter for future alternatives.

### 2. Structured phase protocol

Planner, Reviewer, and Executor exchange stable JSON contracts instead of unstructured text. Every task includes an ID, description, dependencies, scope, risk, acceptance criteria, and status.

### 3. Review feedback loop

The Reviewer returns `approve`, `request_changes`, or `reject`. Review rounds are bounded, and the Reviewer can create follow-up tasks when requirements are not satisfied.

### 4. Human-in-the-loop approval policy

Support approval for the whole plan, individual tasks, or risk categories. Destructive operations, access outside the workspace, and network operations must be surfaced before execution.

### 5. Retry, resume, and idempotency

Provide exponential backoff, error-aware retry policies, task timeouts, process locks, resume from the last incomplete task, and idempotency keys for side-effecting operations.

### 6. Context management and durable memory

Track token budgets, compact context automatically, and store decisions, facts, rules, and artifacts separately. New conversations receive only the relevant structured summary.

### 7. Subtask DAG and execution scheduling

Represent subtasks as a dependency graph. Independent tasks may run in parallel with a configurable concurrency limit. Support priority, dependency failure handling, timeouts, and dynamic decomposition.

### 8. Workspace safety

Normalize and validate paths, prevent path traversal, enforce the workspace boundary, support dry runs, use command allowlists/denylists, detect destructive commands, and create checkpoints before major changes.

### 9. Observability and audit logging

Provide structured JSON logs keyed by `runId` and `taskId`, debug mode, token/cost tracking, latency, retry history, and secret redaction. Logs must explain why an action was taken.

### 10. Provider/model abstraction, role routing, and fallback

Allow separate Reviewer and Developer/Executor provider, model, authentication mode, timeout, rate-limit, retry, and fallback configuration through `.env`, CLI flags, or a config file. CLI flags should override project configuration, while explicit configuration should override defaults. Provider adapters should support login-session authentication, API-key authentication, streaming events, structured output, tool calling, and token counting when available.

## AGENTS.md rules

Discover rules in this order:

1. Global user rules.
2. Workspace-root rules.
3. Rules in relevant subdirectories.
4. Constraints from the current task.

Include rules in the plan as traceable constraints. If rules conflict, report the conflict instead of silently choosing one.

## Streaming event design

Default streaming should expose only high-value events:

- `run_started`
- `plan_ready`
- `approval_required`
- `task_started`
- `command_started`
- `progress`
- `task_failed`
- `review_result`
- `context_compacted`
- `run_completed`

Raw model tokens are opt-in through `--verbose-stream`. By default, the CLI shows summaries, active commands, meaningful progress, errors, review decisions, and state transitions.

## Suggested package structure

```text
src/
  cli/
  orchestration/
  agents/
  providers/
  execution/
  persistence/
  context/
  safety/
  events/
  config/
```

Suggested local state layout:

```text
.agent-loop/
  runs/<run-id>/state.db
  runs/<run-id>/events.jsonl
  runs/<run-id>/artifacts/
  runs/<run-id>/summaries/
```

## Recommended MVP

1. CLI commands: `run`, `resume`, `status`, `approve`, `cancel`, and `logs`.
2. Local SQLite persistence.
3. One Planner/Reviewer role and one Developer/Executor role, with independent provider/model routing.
4. `AGENTS.md` discovery and precedence rules.
5. Structured plan and task schemas.
6. Workspace boundary and basic command safety.
7. Manual, safe, and all approval modes.
8. Selective operational event streaming.
9. Retry, resume, and checkpoint support.
10. Token-aware context compaction.

## MVP acceptance criteria

- A terminated process can resume without rerunning completed tasks.
- The Executor cannot access paths outside the configured workspace.
- The user sees meaningful progress without raw token flooding.
- The Reviewer detects failures and initiates a bounded revision loop.
- A complex prompt becomes a task DAG with acceptance criteria.
- Every command and file change is traceable to a run and task.

## Decisions required before implementation

- Which provider and tool-calling protocol should be supported first?
- Should Git be mandatory, or only used when the workspace is a repository?
- Should the default approval mode be `manual` or `safe`?
- Should network commands be denied by default?
- What token threshold should trigger context compaction?
- What should the default maximum number of review and retry rounds be?
- Which provider CLI login flows should be supported first?
- Which provider-specific API-key environment variables should be mapped by default?

## Naming

Recommended package and CLI name: **`agent-loop`**.

The name communicates the central workflow: `plan -> execute -> review -> revise`, while remaining provider-agnostic and broad enough for checkpointing, retries, and context compaction.

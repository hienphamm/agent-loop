import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { ApprovalGate } from "../../src/execution/approval.js";
import { ApprovalRequiredError } from "../../src/errors/index.js";

function setup() {
  const repository = new Repository(openInMemoryDatabase());
  repository.createRun(
    { id: "run-1", prompt: "p", workspace: "/ws", status: "running" },
    "{}",
  );
  const events = new EventBus();
  return { repository, events };
}

describe("approval concurrency and lifecycle", () => {
  it("resolveApproval is compare-and-set: only the first of two concurrent approvals wins", () => {
    const { repository } = setup();
    const approval = repository.createApproval({
      runId: "run-1",
      taskId: "t1",
      scope: "task",
      summary: "run rm -rf",
    });

    const first = repository.resolveApproval(approval.id, "approved");
    const second = repository.resolveApproval(approval.id, "rejected");

    expect(first).toBe(true);
    expect(second).toBe(false); // lost the race, must not silently overwrite
    expect(repository.getApproval(approval.id)?.status).toBe("approved");
  });

  it("approving after the run was cancelled does not resurrect it: waiter observes cancellation first", async () => {
    const { repository, events } = setup();
    let cancelled = false;
    const gate = new ApprovalGate(repository, events, "manual", {
      pollIntervalMs: 10,
      isCancelled: () => cancelled,
    });

    const pending = gate.requestApproval({
      runId: "run-1",
      taskId: "t1",
      scope: "task",
      summary: "do thing",
    });
    cancelled = true;
    const result = await pending;
    expect(result).toBe(false);

    // Approving afterwards is a no-op from the waiter's perspective (it
    // already returned), and the approval is still sitting there pending —
    // a later `agent-loop approve` still succeeds, but nothing re-runs the
    // already-cancelled wait.
    const approvals = repository.listApprovals("run-1");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("pending");
  });

  it("times out instead of waiting forever, with a clear resume hint", async () => {
    const { repository, events } = setup();
    const gate = new ApprovalGate(repository, events, "manual", {
      pollIntervalMs: 5,
      waitTimeoutMs: 30,
    });
    await expect(
      gate.requestApproval({
        runId: "run-1",
        taskId: "t1",
        scope: "task",
        summary: "slow approval",
      }),
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it("approving a task that has no pending approval (already completed/resolved) reports nothing to approve", () => {
    const { repository } = setup();
    // No approval was ever requested for this task.
    expect(
      repository.getPendingApproval("run-1", "already-done"),
    ).toBeUndefined();
  });

  it("two processes racing to acquire the same run lock: only one wins while the other is alive", () => {
    const { repository } = setup();
    const gotFirst = repository.tryAcquireRunLock(
      "run-1",
      "holder-A",
      process.pid,
    );
    const gotSecond = repository.tryAcquireRunLock(
      "run-1",
      "holder-B",
      process.pid,
    );
    expect(gotFirst).toBe(true);
    expect(gotSecond).toBe(false);
  });

  it("reclaims a run lock left behind by a dead process", () => {
    const { repository } = setup();
    const deadPid = 999_999_991; // astronomically unlikely to be a live pid
    repository.tryAcquireRunLock("run-1", "holder-dead", deadPid);
    const reclaimed = repository.tryAcquireRunLock(
      "run-1",
      "holder-alive",
      process.pid,
    );
    expect(reclaimed).toBe(true);
    expect(repository.getRunLock("run-1")?.holder).toBe("holder-alive");
  });

  it("releasing a lock only removes it if the holder matches", () => {
    const { repository } = setup();
    repository.tryAcquireRunLock("run-1", "holder-A", process.pid);
    repository.releaseRunLock("run-1", "holder-B"); // wrong holder, no-op
    expect(repository.getRunLock("run-1")?.holder).toBe("holder-A");
    repository.releaseRunLock("run-1", "holder-A");
    expect(repository.getRunLock("run-1")).toBeUndefined();
  });

  it("auto-approval under safe mode still records an audit entry even though nobody was asked", async () => {
    const { repository, events } = setup();
    const resolved: unknown[] = [];
    events.onType("approval_resolved", (e) => resolved.push(e.data));
    const gate = new ApprovalGate(repository, events, "safe");

    const approved = await gate.requestApproval({
      runId: "run-1",
      taskId: "t1",
      scope: "task",
      summary: "cat file.txt",
      classification: { risk: "read_only", reasons: [] },
    });

    expect(approved).toBe(true);
    expect(resolved).toHaveLength(1);
    expect(repository.listApprovals("run-1")[0]?.status).toBe("approved");
    expect(repository.listApprovals("run-1")[0]?.decidedBy).toBe("auto");
  });

  it("forceManual overrides auto-approval even in --approval-mode all", async () => {
    const { repository, events } = setup();
    const gate = new ApprovalGate(repository, events, "all", {
      pollIntervalMs: 5,
      waitTimeoutMs: 30,
    });
    await expect(
      gate.requestApproval({
        runId: "run-1",
        taskId: "t1",
        scope: "task",
        summary: "retry with unknown prior outcome",
        forceManual: true,
      }),
    ).rejects.toThrow(ApprovalRequiredError); // times out because nobody approves it
  });
});

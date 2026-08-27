import { describe, expect, it, beforeEach } from "vitest";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";

describe("Repository", () => {
  let repo: Repository;

  beforeEach(() => {
    repo = new Repository(openInMemoryDatabase());
  });

  it("creates and retrieves a run", () => {
    repo.createRun(
      { id: "run-1", prompt: "do stuff", workspace: "/ws", status: "pending" },
      "{}",
    );
    const run = repo.getRun("run-1");
    expect(run?.status).toBe("pending");
  });

  it("moves a task through its status lifecycle", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    repo.insertTasks("run-1", [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    expect(repo.getTask("run-1", "t1")?.status).toBe("pending");

    repo.updateTaskStatus("run-1", "t1", "running");
    expect(repo.getTask("run-1", "t1")?.status).toBe("running");

    repo.updateTaskStatus("run-1", "t1", "completed");
    expect(repo.getTask("run-1", "t1")?.status).toBe("completed");
  });

  it("tracks retry counts", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    repo.insertTasks("run-1", [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    repo.incrementRetry("run-1", "t1");
    repo.incrementRetry("run-1", "t1");
    expect(repo.getTask("run-1", "t1")?.retryCount).toBe(2);
    repo.recordRetry({
      runId: "run-1",
      taskId: "t1",
      attempt: 1,
      error: "boom",
      backoffMs: 1000,
    });
  });

  it("supports approval create/resolve and pending lookup", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    const approval = repo.createApproval({
      runId: "run-1",
      scope: "plan",
      summary: "approve plan",
    });
    expect(repo.getPendingApproval("run-1")?.id).toBe(approval.id);
    repo.resolveApproval(approval.id, "approved");
    expect(repo.getPendingApproval("run-1")).toBeUndefined();
    expect(repo.listApprovals("run-1")[0]?.status).toBe("approved");
  });

  it("dedupes idempotent side effects by key, distinguishing attempted from completed", () => {
    expect(repo.getIdempotencyState("key-1")).toBeUndefined();

    repo.recordIdempotentAttempt("key-1", "run-1", "t1", "low");
    const attempted = repo.getIdempotencyState("key-1");
    expect(attempted?.status).toBe("attempted");
    expect(attempted?.result).toBeUndefined();

    repo.recordIdempotentResult("key-1", "run-1", "t1", "low", { ok: true });
    const completed = repo.getIdempotencyState("key-1");
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toEqual({ ok: true });
  });

  it("redacts secret-shaped fields before persisting task results", () => {
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    repo.insertTasks("run-1", [
      {
        id: "t1",
        description: "d",
        dependencies: [],
        risk: "low",
        acceptanceCriteria: [],
      },
    ]);
    repo.setTaskResult("run-1", "t1", {
      apiKey: "sk-should-not-be-stored",
      output: "fine",
    });
    const task = repo.getTask("run-1", "t1");
    expect(JSON.stringify(task?.result)).not.toContain(
      "sk-should-not-be-stored",
    );
  });

  it("compacts a conversation into a new one carrying the summary", () => {
    const conv = repo.createConversation("run-1", "reviewer");
    const replacement = repo.compactConversation(conv.id, {
      decisions: ["use SQLite"],
      facts: [],
      rules: [],
      artifacts: [],
      openQuestions: [],
    });
    expect(replacement.id).not.toBe(conv.id);
  });
});

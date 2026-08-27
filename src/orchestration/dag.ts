import { AgentLoopError } from "../errors/index.js";
import type { TaskSpec } from "./types.js";

export class DagCycleError extends AgentLoopError {
  constructor(cycle: string[]) {
    super(
      "DAG_CYCLE",
      `Task dependency cycle detected: ${cycle.join(" -> ")}`,
      {
        hint: "Fix the plan so task dependencies form a directed acyclic graph.",
      },
    );
    this.name = "DagCycleError";
  }
}

export class DagMissingDependencyError extends AgentLoopError {
  constructor(taskId: string, dependencyId: string) {
    super(
      "DAG_MISSING_DEPENDENCY",
      `Task "${taskId}" depends on unknown task "${dependencyId}"`,
    );
    this.name = "DagMissingDependencyError";
  }
}

/** Validates a plan's task graph and exposes scheduling helpers. */
export class TaskDag {
  private readonly byId = new Map<string, TaskSpec>();

  constructor(tasks: TaskSpec[]) {
    for (const task of tasks) this.byId.set(task.id, task);
    for (const task of tasks) {
      for (const dep of task.dependencies) {
        if (!this.byId.has(dep))
          throw new DagMissingDependencyError(task.id, dep);
      }
    }
    this.assertAcyclic();
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): TaskSpec | undefined {
    return this.byId.get(id);
  }

  all(): TaskSpec[] {
    return [...this.byId.values()];
  }

  /** Tasks ready to run given a set of already-completed task ids. */
  readyTasks(completed: Set<string>, inFlightOrDone: Set<string>): TaskSpec[] {
    return this.all().filter(
      (t) =>
        !inFlightOrDone.has(t.id) &&
        t.dependencies.every((d) => completed.has(d)),
    );
  }

  /** Topological batches, purely for display/dry-run purposes. */
  topologicalBatches(): string[][] {
    const remaining = new Map(this.byId);
    const done = new Set<string>();
    const batches: string[][] = [];
    while (remaining.size > 0) {
      const batch = [...remaining.values()]
        .filter((t) => t.dependencies.every((d) => done.has(d)))
        .map((t) => t.id);
      if (batch.length === 0) {
        throw new DagCycleError([...remaining.keys()]);
      }
      for (const id of batch) {
        remaining.delete(id);
        done.add(id);
      }
      batches.push(batch);
    }
    return batches;
  }

  private assertAcyclic(): void {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.byId.keys()) color.set(id, WHITE);
    const stack: string[] = [];

    const visit = (id: string): void => {
      color.set(id, GRAY);
      stack.push(id);
      const task = this.byId.get(id);
      for (const dep of task?.dependencies ?? []) {
        const depColor = color.get(dep);
        if (depColor === GRAY) {
          const cycleStart = stack.indexOf(dep);
          throw new DagCycleError([...stack.slice(cycleStart), dep]);
        }
        if (depColor === WHITE) visit(dep);
      }
      stack.pop();
      color.set(id, BLACK);
    };

    for (const id of this.byId.keys()) {
      if (color.get(id) === WHITE) visit(id);
    }
  }
}

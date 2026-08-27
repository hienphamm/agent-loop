import { describe, expect, it } from "vitest";
import {
  DagCycleError,
  DagMissingDependencyError,
  TaskDag,
} from "../../src/orchestration/dag.js";
import type { TaskSpec } from "../../src/orchestration/types.js";

function spec(id: string, dependencies: string[] = []): TaskSpec {
  return {
    id,
    description: id,
    dependencies,
    risk: "low",
    acceptanceCriteria: [],
  };
}

describe("TaskDag", () => {
  it("computes topological batches respecting dependencies", () => {
    const dag = new TaskDag([
      spec("a"),
      spec("b", ["a"]),
      spec("c", ["a"]),
      spec("d", ["b", "c"]),
    ]);
    const batches = dag.topologicalBatches();
    expect(batches[0]).toEqual(["a"]);
    expect(new Set(batches[1])).toEqual(new Set(["b", "c"]));
    expect(batches[2]).toEqual(["d"]);
  });

  it("throws on a dependency cycle", () => {
    expect(() => new TaskDag([spec("a", ["b"]), spec("b", ["a"])])).toThrow(
      DagCycleError,
    );
  });

  it("throws when a dependency does not exist", () => {
    expect(() => new TaskDag([spec("a", ["ghost"])])).toThrow(
      DagMissingDependencyError,
    );
  });

  it("readyTasks only returns tasks whose dependencies are complete", () => {
    const dag = new TaskDag([spec("a"), spec("b", ["a"])]);
    expect(dag.readyTasks(new Set(), new Set()).map((t) => t.id)).toEqual([
      "a",
    ]);
    expect(
      dag.readyTasks(new Set(["a"]), new Set(["a"])).map((t) => t.id),
    ).toEqual(["b"]);
  });
});

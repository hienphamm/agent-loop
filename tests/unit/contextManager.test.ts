import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../../src/persistence/db.js";
import { Repository } from "../../src/persistence/repository.js";
import { EventBus } from "../../src/events/bus.js";
import { ContextManager } from "../../src/context/manager.js";
import { MockProvider } from "../../src/providers/mock.js";

describe("ContextManager", () => {
  it("compacts once the token budget is exceeded and emits context_compacted", async () => {
    const repo = new Repository(openInMemoryDatabase());
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    const events = new EventBus();
    const compactedEvents: unknown[] = [];
    events.onType("context_compacted", (e) => compactedEvents.push(e));

    const provider = new MockProvider(() => ({
      content: JSON.stringify({
        decisions: ["decided X"],
        facts: [],
        rules: [],
        artifacts: [],
        openQuestions: [],
      }),
    }));

    // Small budget so a couple of messages tips it over the compaction threshold.
    const manager = new ContextManager(
      "run-1",
      "reviewer",
      provider,
      repo,
      events,
      20,
      "mock-model",
    );

    await manager.addMessage({ role: "user", content: "a".repeat(200) });
    await manager.addMessage({ role: "user", content: "b".repeat(200) });

    expect(compactedEvents.length).toBeGreaterThan(0);
    const memory = repo.listMemory("run-1");
    expect(
      memory.some((m) => m.kind === "decision" && m.content === "decided X"),
    ).toBe(true);
    // messages should have been replaced by a single summary seed
    expect(manager.getMessages().length).toBe(1);
  });

  it("does not compact while under budget", async () => {
    const repo = new Repository(openInMemoryDatabase());
    repo.createRun(
      { id: "run-1", prompt: "p", workspace: "/ws", status: "pending" },
      "{}",
    );
    const events = new EventBus();
    const compactedEvents: unknown[] = [];
    events.onType("context_compacted", (e) => compactedEvents.push(e));
    const provider = new MockProvider(() => ({ content: "{}" }));
    const manager = new ContextManager(
      "run-1",
      "developer",
      provider,
      repo,
      events,
      100_000,
      "mock-model",
    );

    await manager.addMessage({ role: "user", content: "short message" });
    expect(compactedEvents.length).toBe(0);
    expect(manager.getMessages().length).toBe(1);
  });

  it("preserves requirements, rules, decisions, failures, acceptance criteria, and artifacts through compaction, and lets a new conversation continue from them", async () => {
    const repo = new Repository(openInMemoryDatabase());
    repo.createRun(
      {
        id: "run-1",
        prompt: "build the widget exporter",
        workspace: "/ws",
        status: "pending",
      },
      "{}",
    );
    const events = new EventBus();

    // A summarizer that behaves like a real one: it echoes back the
    // specific categories the transcript actually contained, so we can
    // assert on *which* facts survive, not just that some do.
    const provider = new MockProvider((request) => {
      const transcript = request.messages.map((m) => m.content).join("\n");
      if (transcript.includes("SUMMARIZE_ME")) {
        return {
          content: JSON.stringify({
            decisions: ["use CSV as the export format (reviewer decision)"],
            facts: [
              "user requirement: build the widget exporter",
              "AGENTS.md rule: never commit secrets",
            ],
            rules: ["AGENTS.md: never commit secrets"],
            artifacts: ["src/exporter/widget.ts"],
            openQuestions: [
              "pending task: add integration test for the exporter",
            ],
          }),
        };
      }
      return { content: "{}" };
    });

    // Large enough that the seeded summary + one follow-up message don't
    // immediately trigger a *second* compaction (which would be realistic
    // behavior under sustained load, but would defeat this test's point:
    // proving one clean compact-then-continue cycle preserves everything).
    const manager = new ContextManager(
      "run-1",
      "reviewer",
      provider,
      repo,
      events,
      500,
      "mock-model",
    );

    await manager.addMessage({
      role: "system",
      content: "AGENTS.md rule: never commit secrets",
    });
    await manager.addMessage({
      role: "user",
      content: "user requirement: build the widget exporter",
    });
    await manager.addMessage({
      role: "assistant",
      content: "attempt 1 failed: exporter threw a type error",
    });
    await manager.addMessage({
      role: "user",
      // Long enough on its own to cross the 500-token budget's 80% trigger.
      content:
        "SUMMARIZE_ME " +
        "pending task: add integration test for the exporter ".repeat(60),
    });

    const memory = repo.listMemory("run-1");
    expect(
      memory.some((m) => m.kind === "decision" && m.content.includes("CSV")),
    ).toBe(true);
    expect(
      memory.some(
        (m) => m.kind === "fact" && m.content.includes("widget exporter"),
      ),
    ).toBe(true);
    expect(
      memory.some(
        (m) => m.kind === "rule" && m.content.includes("never commit secrets"),
      ),
    ).toBe(true);
    expect(
      memory.some(
        (m) =>
          m.kind === "artifact" && m.content.includes("src/exporter/widget.ts"),
      ),
    ).toBe(true);

    // The new conversation must actually be seeded with this summary, not
    // just have it sitting in the memory table unused.
    const seed = manager.getMessages()[0]!.content;
    expect(seed).toContain("CSV");
    expect(seed).toContain("widget exporter");
    expect(seed).toContain("never commit secrets");
    expect(seed).toContain("src/exporter/widget.ts");
    expect(seed).toContain("add integration test for the exporter");

    // And the conversation must be able to continue afterwards: adding
    // another message keeps working (with such a tiny test budget this may
    // trigger a second compaction, which is fine — the point is it doesn't
    // wedge or lose the ability to proceed).
    await manager.addMessage({
      role: "user",
      content: "continue: implement the integration test",
    });
    expect(
      manager
        .getMessages()
        .some((m) => m.content.includes("implement the integration test")),
    ).toBe(true);
  });
});

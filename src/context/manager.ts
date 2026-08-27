import type { EventBus } from "../events/bus.js";
import type { Repository } from "../persistence/repository.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { ChatMessage } from "../providers/types.js";
import type {
  ConversationRole,
  StructuredSummary,
} from "../orchestration/types.js";
import { shouldCompact } from "./tokenBudget.js";

/**
 * Tracks one role's rolling conversation, compacting it into a structured
 * summary before it would blow the configured token budget, and starting a
 * fresh conversation seeded only with that summary plus durable memory.
 */
export class ContextManager {
  private messages: ChatMessage[] = [];
  private conversationId: string;
  private tokenCount = 0;

  constructor(
    private readonly runId: string,
    private readonly role: ConversationRole,
    private readonly provider: ProviderAdapter,
    private readonly repository: Repository,
    private readonly events: EventBus,
    private readonly tokenBudget: number,
    private readonly model: string,
  ) {
    const conversation = repository.createConversation(runId, role);
    this.conversationId = conversation.id;
  }

  get currentConversationId(): string {
    return this.conversationId;
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  async addMessage(message: ChatMessage): Promise<void> {
    this.messages.push(message);
    this.tokenCount += this.provider.estimateTokens(message.content);
    this.repository.updateConversationTokens(
      this.conversationId,
      this.tokenCount,
    );

    if (shouldCompact(this.tokenCount, this.tokenBudget)) {
      await this.compact();
    }
  }

  private async compact(): Promise<void> {
    const beforeTokens = this.tokenCount;
    const summary = await this.summarize();

    for (const decision of summary.decisions)
      this.repository.addMemory({
        runId: this.runId,
        kind: "decision",
        content: decision,
      });
    for (const fact of summary.facts)
      this.repository.addMemory({
        runId: this.runId,
        kind: "fact",
        content: fact,
      });
    for (const rule of summary.rules)
      this.repository.addMemory({
        runId: this.runId,
        kind: "rule",
        content: rule,
      });
    for (const artifact of summary.artifacts)
      this.repository.addMemory({
        runId: this.runId,
        kind: "artifact",
        content: artifact,
      });

    const replacement = this.repository.compactConversation(
      this.conversationId,
      summary,
    );
    this.conversationId = replacement.id;

    const seed: ChatMessage = {
      role: "system",
      content: renderSummaryAsContext(summary),
    };
    this.messages = [seed];
    this.tokenCount = this.provider.estimateTokens(seed.content);
    this.repository.updateConversationTokens(
      this.conversationId,
      this.tokenCount,
    );

    this.events.emit({
      runId: this.runId,
      type: "context_compacted",
      data: { role: this.role, beforeTokens, afterTokens: this.tokenCount },
    });
  }

  private async summarize(): Promise<StructuredSummary> {
    const transcript = this.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    const result = await this.provider.complete({
      model: this.model,
      jsonMode: true,
      messages: [
        {
          role: "system",
          content:
            "Summarize this conversation into JSON with keys decisions, facts, rules, artifacts, openQuestions (each an array of short strings). Keep only information needed to continue the work correctly.",
        },
        { role: "user", content: transcript },
      ],
    });
    return parseSummary(result.content);
  }
}

function parseSummary(raw: string): StructuredSummary {
  try {
    const parsed = JSON.parse(raw) as Partial<StructuredSummary>;
    return {
      decisions: parsed.decisions ?? [],
      facts: parsed.facts ?? [],
      rules: parsed.rules ?? [],
      artifacts: parsed.artifacts ?? [],
      openQuestions: parsed.openQuestions ?? [],
    };
  } catch {
    return {
      decisions: [],
      facts: [],
      rules: [],
      artifacts: [],
      openQuestions: [raw.slice(0, 500)],
    };
  }
}

function renderSummaryAsContext(summary: StructuredSummary): string {
  const section = (title: string, items: string[]) =>
    items.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
  return [
    "Context compacted from a prior conversation. Continue using this summary:",
    section("Decisions", summary.decisions),
    section("Facts", summary.facts),
    section("Rules", summary.rules),
    section("Artifacts", summary.artifacts),
    section("Open questions", summary.openQuestions),
  ]
    .filter(Boolean)
    .join("\n\n");
}

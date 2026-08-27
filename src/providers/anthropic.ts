import { ProviderError } from "../errors/index.js";
import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** Minimal Anthropic Messages API adapter using the built-in fetch client. */
export class AnthropicProvider implements ProviderAdapter {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com/v1",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = request.messages.find((m) => m.role === "system")?.content;
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: request.model,
          system,
          messages,
          max_tokens: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 0.2,
        }),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new ProviderError(
          `Anthropic request timed out after ${this.timeoutMs}ms`,
          undefined,
          true,
        );
      }
      throw new ProviderError(
        `Anthropic request failed: ${(error as Error).message}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(
        `Anthropic request failed (${response.status}): ${truncate(body)}`,
        response.status === 401 || response.status === 403
          ? "Check AGENT_LOOP_*_API_KEY / ANTHROPIC_API_KEY."
          : undefined,
        retryable,
      );
    }
    const json = (await response.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    const content = json.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      content,
      promptTokens: json.usage?.input_tokens,
      completionTokens: json.usage?.output_tokens,
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

function truncate(text: string, max = 500): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

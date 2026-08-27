import { ProviderError } from "../errors/index.js";
import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** Minimal OpenAI Chat Completions adapter using the built-in fetch client. */
export class OpenAiProvider implements ProviderAdapter {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature ?? 0.2,
          ...(request.jsonMode
            ? { response_format: { type: "json_object" } }
            : {}),
        }),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new ProviderError(
          `OpenAI request timed out after ${this.timeoutMs}ms`,
          undefined,
          true,
        );
      }
      throw new ProviderError(
        `OpenAI request failed: ${(error as Error).message}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 401/403 (auth), 400 (bad request/malformed) won't be fixed by retrying.
      // 429 (rate limit) and 5xx (transient provider failure) are worth retrying.
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(
        `OpenAI request failed (${response.status}): ${truncate(body)}`,
        response.status === 401 || response.status === 403
          ? "Check AGENT_LOOP_*_API_KEY / OPENAI_API_KEY."
          : undefined,
        retryable,
      );
    }
    const json = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const content = json.choices[0]?.message.content ?? "";
    return {
      content,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

function truncate(text: string, max = 500): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

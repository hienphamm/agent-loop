import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
  TokenListener,
} from "./types.js";

export type MockResponder = (
  request: CompletionRequest,
) => CompletionResult | Promise<CompletionResult>;

/**
 * Deterministic, network-free provider used by tests, dry runs, and anyone
 * evaluating the CLI without a live provider account.
 */
export class MockProvider implements ProviderAdapter {
  readonly name = "mock";

  constructor(private readonly responder: MockResponder) {}

  async complete(
    request: CompletionRequest,
    onToken?: TokenListener,
  ): Promise<CompletionResult> {
    const result = await this.responder(request);
    if (onToken) {
      for (const chunk of result.content.split(/(?<=\s)/)) onToken(chunk);
    }
    return result;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

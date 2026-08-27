export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** Ask the provider to return strict JSON matching the caller's contract. */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

export type TokenListener = (token: string) => void;

export interface ProviderAdapter {
  readonly name: string;
  complete(
    request: CompletionRequest,
    onToken?: TokenListener,
  ): Promise<CompletionResult>;
  /** Rough token estimate for context-budget accounting; providers may override with a real tokenizer. */
  estimateTokens(text: string): number;
}

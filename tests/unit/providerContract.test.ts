import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "../../src/providers/openai.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ProviderError } from "../../src/errors/index.js";
import { isRetryableError } from "../../src/orchestration/retry.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

/**
 * All provider adapters (mock included) must honor the same contract:
 * - a normal request resolves to { content, ...tokenCounts }
 * - a malformed/erroring backend surfaces as ProviderError
 * - auth failures (401/403) are NOT retryable
 * - rate limits (429) and server errors (5xx) ARE retryable
 * - a timeout surfaces as a (retryable) ProviderError, not a hang
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe.each([
  {
    name: "openai",
    make: (baseUrl: string, timeoutMs?: number) =>
      new OpenAiProvider("test-key", baseUrl, timeoutMs),
    successBody: {
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    },
    errorBody: { error: "nope" },
  },
  {
    name: "anthropic",
    make: (baseUrl: string, timeoutMs?: number) =>
      new AnthropicProvider("test-key", baseUrl, timeoutMs),
    successBody: {
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    errorBody: { error: "nope" },
  },
])("$name provider contract", ({ make, successBody, errorBody }) => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns content on a normal response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(successBody));
    const provider = make("https://example.invalid");
    const result = await provider.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("hi");
  });

  it("throws a non-retryable ProviderError on 401 (authentication failure)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(errorBody, 401));
    const provider = make("https://example.invalid");
    await expect(
      provider.complete({ model: "m", messages: [] }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
    });
  });

  it("throws a retryable ProviderError on 429 (rate limit)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(errorBody, 429));
    const provider = make("https://example.invalid");
    let caught: unknown;
    try {
      await provider.complete({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(isRetryableError(caught)).toBe(true);
  });

  it("throws a retryable ProviderError on 500 (provider error)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(errorBody, 500));
    const provider = make("https://example.invalid");
    let caught: unknown;
    try {
      await provider.complete({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(isRetryableError(caught)).toBe(true);
  });

  it("throws a non-retryable ProviderError on 400 (bad request / malformed input)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(errorBody, 400));
    const provider = make("https://example.invalid");
    let caught: unknown;
    try {
      await provider.complete({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(isRetryableError(caught)).toBe(false);
  });

  it("surfaces a hung request as a timeout instead of hanging forever", async () => {
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;
    const provider = make("https://example.invalid", 20);
    let caught: unknown;
    try {
      await provider.complete({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).message).toContain("timed out");
    expect(isRetryableError(caught)).toBe(true);
  });
});

describe("MockProvider follows the same contract", () => {
  it("resolves normally", async () => {
    const provider: ProviderAdapter = new MockProvider(() => ({
      content: "ok",
    }));
    const result = await provider.complete({ model: "m", messages: [] });
    expect(result.content).toBe("ok");
  });

  it("can simulate a non-retryable auth-style failure", async () => {
    const provider: ProviderAdapter = new MockProvider(() => {
      throw new ProviderError("simulated 401", undefined, false);
    });
    let caught: unknown;
    try {
      await provider.complete({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(isRetryableError(caught)).toBe(false);
  });

  it("can simulate a retryable transient failure", async () => {
    const provider: ProviderAdapter = new MockProvider(() => {
      throw new ProviderError("simulated 503", undefined, true);
    });
    let caught: unknown;
    try {
      await provider.complete({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(isRetryableError(caught)).toBe(true);
  });

  it("supports streaming raw tokens via the onToken callback", async () => {
    const provider: ProviderAdapter = new MockProvider(() => ({
      content: "hello world",
    }));
    const tokens: string[] = [];
    await provider.complete({ model: "m", messages: [] }, (t) =>
      tokens.push(t),
    );
    expect(tokens.join("")).toBe("hello world");
  });

  it("surfaces malformed structured output as a parse failure at the call site, not a silent success", async () => {
    // The provider itself doesn't validate JSON shape — that's the caller's
    // (Planner/Reviewer/Developer) job. Confirm the raw content really does
    // come through unparsed so callers can't accidentally treat garbage as success.
    const provider: ProviderAdapter = new MockProvider(() => ({
      content: "not json at all",
    }));
    const result = await provider.complete({
      model: "m",
      messages: [],
      jsonMode: true,
    });
    expect(() => JSON.parse(result.content)).toThrow();
  });
});

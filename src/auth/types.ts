export interface AuthCheckResult {
  ok: boolean;
  message: string;
  /** Command the user should run to fix the problem, if any. */
  remedyCommand?: string;
}

export interface AuthAdapter {
  readonly mode: "cli" | "api_key";
  /** Verify the session/key is usable. Must never throw for expected failures. */
  check(): Promise<AuthCheckResult>;
}

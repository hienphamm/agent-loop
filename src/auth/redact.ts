/**
 * Central secret redaction. Every surface that can emit text to the user
 * (events, logs, error messages, checkpoints) must run through this module
 * before being written or printed.
 */

const registeredSecrets = new Set<string>();

/** Register a runtime secret value so it gets scrubbed from all future output. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < 4) return; // too short to safely redact without false positives
  registeredSecrets.add(trimmed);
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

const KEY_LIKE_PATTERN =
  /\b(sk-[a-zA-Z0-9_-]{10,}|api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9_\-/.]{8,}['"]?|Bearer\s+[a-zA-Z0-9_\-.]{10,})/gi;

/** Redact any known secret value plus generically key-shaped strings. */
export function redact(input: string): string {
  let output = input;
  for (const secret of registeredSecrets) {
    if (secret.length === 0) continue;
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(KEY_LIKE_PATTERN, "[REDACTED]");
  return output;
}

/** Deep-redact an object graph (used before persisting or emitting events). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redact(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /api[_-]?key|secret|token|password|authorization/i.test(key);
}

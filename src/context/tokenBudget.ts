export const COMPACTION_TRIGGER_RATIO = 0.8;

export function shouldCompact(currentTokens: number, budget: number): boolean {
  return currentTokens >= budget * COMPACTION_TRIGGER_RATIO;
}

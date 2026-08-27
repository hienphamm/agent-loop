import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentsMdLevel = "global" | "workspace" | "subdirectory";

export interface AgentsMdSource {
  level: AgentsMdLevel;
  path: string;
  rules: string[]; // freeform bullet rules, in file order
  directives: Record<string, string>; // "key: value" lines
}

export interface AgentsMdConflict {
  key: string;
  values: { source: string; value: string }[];
}

export interface AgentsMdDiscoveryResult {
  sources: AgentsMdSource[];
  /** Rules in final precedence order: global, then workspace, then subdirectories (deepest last = highest precedence). */
  orderedRules: string[];
  conflicts: AgentsMdConflict[];
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".agent-loop"]);
const MAX_DEPTH = 6;

export function discoverAgentsMd(
  workspaceRoot: string,
  homeDir = os.homedir(),
): AgentsMdDiscoveryResult {
  const sources: AgentsMdSource[] = [];

  const globalPath = path.join(homeDir, ".agent-loop", "AGENTS.md");
  const globalFallback = path.join(homeDir, "AGENTS.md");
  const globalFile = existsSync(globalPath)
    ? globalPath
    : existsSync(globalFallback)
      ? globalFallback
      : undefined;
  if (globalFile) sources.push(parseSource("global", globalFile));

  const workspaceFile = path.join(workspaceRoot, "AGENTS.md");
  if (existsSync(workspaceFile))
    sources.push(parseSource("workspace", workspaceFile));

  for (const subFile of findSubdirectoryAgentsMd(workspaceRoot)) {
    sources.push(parseSource("subdirectory", subFile));
  }

  const orderedRules = sources.flatMap((s) => s.rules);
  const conflicts = detectConflicts(sources);

  return { sources, orderedRules, conflicts };
}

function findSubdirectoryAgentsMd(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry === "AGENTS.md" && dir !== root) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

function parseSource(level: AgentsMdLevel, filePath: string): AgentsMdSource {
  const content = readFileSync(filePath, "utf8");
  const rules: string[] = [];
  const directives: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bulletMatch = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bulletMatch) {
      rules.push(bulletMatch[1] as string);
      continue;
    }
    const directiveMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/.exec(
      trimmed,
    );
    if (directiveMatch && !trimmed.startsWith("#")) {
      directives[directiveMatch[1] as string] = directiveMatch[2] as string;
    }
  }
  return { level, path: filePath, rules, directives };
}

function detectConflicts(sources: AgentsMdSource[]): AgentsMdConflict[] {
  const byKey = new Map<string, { source: string; value: string }[]>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.directives)) {
      const list = byKey.get(key) ?? [];
      list.push({ source: source.path, value });
      byKey.set(key, list);
    }
  }
  const conflicts: AgentsMdConflict[] = [];
  for (const [key, values] of byKey) {
    const distinctValues = new Set(values.map((v) => v.value));
    if (distinctValues.size > 1) conflicts.push({ key, values });
  }
  return conflicts;
}

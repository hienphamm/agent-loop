export type CommandRisk = "read_only" | "low" | "destructive" | "network";

export interface CommandClassification {
  risk: CommandRisk;
  reasons: string[];
}

/**
 * IMPORTANT: this is pattern-based risk *classification*, used to decide
 * what needs human approval and what gets logged how. It is NOT a sandbox
 * and it cannot stop a command from doing what it says: a classified
 * "low" risk command can still run `curl` via a variable, obfuscated
 * command substitution, or any other shell trick that doesn't match these
 * literal patterns. Actual enforcement of the workspace boundary happens
 * only for the file paths this process itself touches (see workspace.ts);
 * once a shell command is approved to run, it runs with the same
 * privileges the invoking OS user has — there is no chroot/container/
 * seccomp boundary in this MVP. Treat every approval (especially under
 * `--approval-mode safe`/`all`) as "I trust this command to run as me."
 */

const DESTRUCTIVE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\brm\s+(-\w*r\w*f|-\w*f\w*r|-rf|-fr)\b/i,
    reason: "recursive forced delete",
  },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "discards uncommitted work" },
  {
    pattern: /\bgit\s+push\s+.*--force\b/i,
    reason: "force push can overwrite remote history",
  },
  {
    pattern: /\bgit\s+clean\s+-\w*d\w*f\b/i,
    reason: "deletes untracked files",
  },
  { pattern: /\bdd\s+if=/i, reason: "raw disk write" },
  { pattern: /\bmkfs\b/i, reason: "formats a filesystem" },
  {
    pattern: />\s*\/dev\/(sd|nvme|disk)/i,
    reason: "writes directly to a block device",
  },
  {
    pattern: /\bchmod\s+-R\s+777\b/i,
    reason: "overly permissive recursive chmod",
  },
  { pattern: /\bsudo\b/i, reason: "elevated privileges" },
  { pattern: /\bshutdown\b|\breboot\b/i, reason: "system power state change" },
  { pattern: /\bkill\s+-9\s+-?1\b/i, reason: "kills all processes" },
  { pattern: /:\(\)\s*\{.*\}\s*;/, reason: "fork bomb pattern" },
  {
    pattern: /\bcd\s+(\.\.(\/|\\|$)|\/(?!$)|~)/i,
    reason:
      "changes directory outside the task's working directory; anything after `&&`/`;`/newline then runs there, outside the workspace boundary the executor otherwise enforces",
  },
  {
    pattern: /\bgit\s+submodule\b|\bgit\s+clone\b.*--recurse-submodules/i,
    reason: "submodules can point at arbitrary external repositories and paths",
  },
  {
    pattern: /GIT_DIR\s*=|--git-dir\b|--work-tree\b/i,
    reason:
      "overrides git's working tree/repo location, which can target paths outside the workspace",
  },
];

const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b|\bnetcat\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bpip\s+install\b/i,
  /\bnpm\s+(install|i)\b(?!.*--offline)/i,
];

const READ_ONLY_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|grep|find|head|tail|pwd|echo|wc|diff|git\s+(status|log|diff|show|branch)|node\s+--version|npm\s+ls)\b/i,
];

/** Classifies a shell command string for approval-mode and audit purposes. */
export function classifyCommand(command: string): CommandClassification {
  const reasons: string[] = [];
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) reasons.push(reason);
  }
  if (reasons.length > 0) return { risk: "destructive", reasons };

  if (NETWORK_PATTERNS.some((p) => p.test(command))) {
    return { risk: "network", reasons: ["performs network access"] };
  }

  if (READ_ONLY_PATTERNS.some((p) => p.test(command))) {
    return { risk: "read_only", reasons: [] };
  }

  return { risk: "low", reasons: [] };
}

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAgentsMd } from "../../src/agentsMd/discover.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-loop-agentsmd-"));
}

describe("discoverAgentsMd", () => {
  it("discovers workspace-root and subdirectory files with correct precedence order", () => {
    const ws = makeWorkspace();
    writeFileSync(
      path.join(ws, "AGENTS.md"),
      "- always run tests before committing\napproval_mode: manual\n",
    );
    mkdirSync(path.join(ws, "packages", "api"), { recursive: true });
    writeFileSync(
      path.join(ws, "packages", "api", "AGENTS.md"),
      "- never touch the payments table directly\n",
    );

    const result = discoverAgentsMd(ws, "/nonexistent-home");
    expect(result.orderedRules).toContain("always run tests before committing");
    expect(result.orderedRules).toContain(
      "never touch the payments table directly",
    );
    expect(result.sources.map((s) => s.level)).toEqual([
      "workspace",
      "subdirectory",
    ]);
  });

  it("reports conflicting directives across files instead of silently picking one", () => {
    const ws = makeWorkspace();
    writeFileSync(path.join(ws, "AGENTS.md"), "approval_mode: manual\n");
    mkdirSync(path.join(ws, "sub"));
    writeFileSync(path.join(ws, "sub", "AGENTS.md"), "approval_mode: all\n");

    const result = discoverAgentsMd(ws, "/nonexistent-home");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.key).toBe("approval_mode");
  });

  it("returns no sources when nothing is present", () => {
    const ws = makeWorkspace();
    const result = discoverAgentsMd(ws, "/nonexistent-home");
    expect(result.sources).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveWorkspacePath,
  assertWorkspaceRootValid,
} from "../../src/execution/workspace.js";
import { WorkspaceSafetyError } from "../../src/errors/index.js";

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-loop-ws-"));
  mkdirSync(path.join(dir, "sub"));
  return dir;
}

describe("resolveWorkspacePath", () => {
  it("resolves a relative path inside the workspace", () => {
    const ws = makeWorkspace();
    const resolved = resolveWorkspacePath(ws, "sub/file.txt");
    expect(resolved).toBe(path.join(ws, "sub", "file.txt"));
  });

  it("rejects simple parent traversal", () => {
    const ws = makeWorkspace();
    expect(() => resolveWorkspacePath(ws, "../outside.txt")).toThrow(
      WorkspaceSafetyError,
    );
  });

  it("rejects deeply nested traversal", () => {
    const ws = makeWorkspace();
    expect(() => resolveWorkspacePath(ws, "sub/../../outside.txt")).toThrow(
      WorkspaceSafetyError,
    );
  });

  it("rejects an absolute path outside the workspace", () => {
    const ws = makeWorkspace();
    expect(() => resolveWorkspacePath(ws, "/etc/passwd")).toThrow(
      WorkspaceSafetyError,
    );
  });

  it("rejects a symlink that escapes the workspace", () => {
    const ws = makeWorkspace();
    const outside = mkdtempSync(path.join(tmpdir(), "agent-loop-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "top secret");
    symlinkSync(outside, path.join(ws, "escape"));
    expect(() => resolveWorkspacePath(ws, "escape/secret.txt")).toThrow(
      WorkspaceSafetyError,
    );
  });

  it("allows an absolute path that is inside the workspace", () => {
    const ws = makeWorkspace();
    const resolved = resolveWorkspacePath(ws, path.join(ws, "sub", "file.txt"));
    expect(resolved).toBe(path.join(ws, "sub", "file.txt"));
  });
});

describe("assertWorkspaceRootValid", () => {
  it("throws when the workspace directory does not exist", () => {
    expect(() =>
      assertWorkspaceRootValid("/definitely/not/a/real/path/xyz"),
    ).toThrow(WorkspaceSafetyError);
  });
});

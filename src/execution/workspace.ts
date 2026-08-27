import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { WorkspaceSafetyError } from "../errors/index.js";

/**
 * Resolves a user-supplied relative path against the workspace root and
 * guarantees the result stays inside that root. This is the single
 * chokepoint every file read/write/execute path must go through.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  requested: string,
): string {
  const root = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(root, requested);

  const relative = path.relative(root, candidate);
  const escapes =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (escapes) {
    throw new WorkspaceSafetyError(
      `Path "${requested}" resolves outside the workspace (${root})`,
      "Executor actions are confined to the configured workspace; use a path inside it.",
    );
  }

  // Defend against symlink escapes: if any existing ancestor is a symlink
  // pointing outside the workspace, reject even though the literal path
  // looked safe. Compare against the workspace root's *real* path, since on
  // some platforms the root itself sits behind a symlink (e.g. macOS /tmp).
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  let probe = candidate;
  while (probe !== root && probe !== path.dirname(probe)) {
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      const realRelative = path.relative(realRoot, real);
      if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`)) {
        throw new WorkspaceSafetyError(
          `Path "${requested}" resolves through a symlink outside the workspace`,
        );
      }
      break;
    }
    probe = path.dirname(probe);
  }

  return candidate;
}

export function assertWorkspaceRootValid(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  if (!existsSync(root)) {
    throw new WorkspaceSafetyError(
      `Workspace directory does not exist: ${root}`,
      "Create the directory first, or point --workspace at an existing one.",
    );
  }
  return root;
}

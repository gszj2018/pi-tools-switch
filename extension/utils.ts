/**
 * Shared helpers for pi-tools-switch: built-in tool metadata, identifier
 * validation, and cross-platform path handling.
 */
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, sep } from "node:path";

/** The 7 built-in tools managed by this extension, in status display order. */
export type BuiltinToolName = "read" | "write" | "edit" | "bash" | "find" | "grep" | "ls";

/** Built-in tool names in status display order. */
export const BUILTIN_TOOL_NAMES: readonly BuiltinToolName[] = [
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
];

/** Set form of BUILTIN_TOOL_NAMES for membership checks. */
export const BUILTIN_TOOL_SET: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);

/** Type guard for built-in tool names. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return BUILTIN_TOOL_SET.has(name);
}

/** Tools treated as read-only by the gating logic. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "find", "grep", "ls"];

const PRESET_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** Validate a preset/mode name: `[a-z][a-z0-9_-]*`. */
export function isValidPresetName(name: string): boolean {
  return PRESET_NAME_RE.test(name);
}

/** Normalize a path to POSIX separators for cross-platform comparison. */
export function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

const IS_WINDOWS = process.platform === "win32";

/** Uppercase the drive letter of a Windows-style absolute path ("c:/..." -> "C:/..."). */
function normalizeDriveLetter(path: string): string {
  const match = /^([A-Za-z])(:)(\/|$)/.exec(path);
  if (!match) return path;
  return match[1].toUpperCase() + match[2] + match[3] + path.slice(match[0].length);
}

/**
 * Normalize a path for comparison: POSIX separators, plus lowercase the drive
 * letter on Windows (the most common case mismatch). Directory/file names are
 * left untouched: callers should keep them consistent with cwd/config casing.
 */
export function toComparablePath(path: string): string {
  const normalized = toPosixPath(path);
  return IS_WINDOWS ? normalizeDriveLetter(normalized) : normalized;
}

/**
 * Resolve a user-supplied directory spec to an absolute path:
 * `~`/`~/...` expands to the home directory, other relative specs resolve
 * against cwd; absolute specs are returned unchanged.
 */
export function resolveDir(spec: string, cwd: string): string {
  let expanded = spec;
  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Return true when `target` (a file path) lies inside or exactly on one of the
 * allowed directories. Comparison uses POSIX-normalized absolute paths so it
 * works on Windows and POSIX alike.
 */
export function isPathInDirs(target: string, allowedDirs: readonly string[], cwd: string): boolean {
  if (allowedDirs.length === 0) return false;
  const targetAbs = toComparablePath(resolve(cwd, target));
  for (const spec of allowedDirs) {
    const dir = toComparablePath(resolveDir(spec, cwd));
    const rel = posix.relative(dir, targetAbs);
    if (rel === "" || (rel !== ".." && !rel.startsWith("../"))) return true;
  }
  return false;
}

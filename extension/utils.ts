/**
 * Shared helpers for pi-tools-switch: built-in tool metadata, identifier
 * validation, and cross-platform path handling.
 */
import { homedir } from "node:os";
import * as path from "node:path";
import {
  isPathInDirs as isPathInDirsWithRuntime,
  resolveDir as resolveDirWithRuntime,
  type PathRuntime,
} from "./utils-path.ts";

const DEFAULT_PATH_RUNTIME: PathRuntime = {
  platform: process.platform,
  isAbsolute: path.isAbsolute,
  join: path.join,
  relative: path.relative,
  resolve: path.resolve,
  homeDir: homedir(),
};

/** The 8 built-in tools managed by this extension, in status display order. */
export type BuiltinToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "powershell"
  | "find"
  | "grep"
  | "ls";

/** Built-in tool names in status display order. */
export const BUILTIN_TOOL_NAMES: readonly BuiltinToolName[] = [
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
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

/** Resolve an allowWriteDir configuration entry with the production path runtime. */
export function resolveDir(spec: string, cwd: string): string {
  return resolveDirWithRuntime(spec, cwd, DEFAULT_PATH_RUNTIME);
}

/**
 * Return true when a write/edit target lies strictly inside an allowed
 * directory, using Pi-compatible tool-input path handling.
 */
export function isPathInDirs(target: string, allowedDirs: readonly string[], cwd: string): boolean {
  try {
    return isPathInDirsWithRuntime(target, allowedDirs, cwd, DEFAULT_PATH_RUNTIME);
  } catch {
    return false;
  }
}

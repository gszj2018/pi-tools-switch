/**
 * Platform-injected path helpers for write/edit gating.
 *
 * All environment-specific behavior is supplied by PathRuntime so the helpers
 * can be tested against simulated Windows and POSIX path semantics.
 */
export interface PathRuntime {
  readonly platform: NodeJS.Platform;
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: string[]) => string;
  readonly relative: (from: string, to: string) => string;
  readonly resolve: (...paths: string[]) => string;
  readonly homeDir: string;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;

export const MSG_UNSUPPORTED_UNICODE_SPACE = "Unicode-space";
export const MSG_UNSUPPORTED_LEADING_AT = "leading-@";
export const MSG_UNSUPPORTED_WINDOWS_SHELL_STYLE = "WSL/Cygwin/MSYS2 shell-style";
export const MSG_UNSUPPORTED_HOME_PATH = "home-path";
export const MSG_UNSUPPORTED_FILE_URL = "file:// URL";

function isWindowsShellPath(input: string, runtime: PathRuntime): boolean {
  return (
    runtime.platform === "win32" &&
    input.startsWith("/") &&
    !input.startsWith("//") &&
    !input.includes("\\") &&
    /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/.*)?$/i.test(input)
  );
}

function unsupportedPath(pathCase: string): never {
  throw new Error(`${pathCase} is not supported in current mode`);
}

/** Validate a write/edit tool path without applying Pi-specific conversions. */
function normalizePath(input: string, runtime: PathRuntime): string {
  if (UNICODE_SPACES.test(input)) unsupportedPath(MSG_UNSUPPORTED_UNICODE_SPACE);
  if (input.startsWith("@")) unsupportedPath(MSG_UNSUPPORTED_LEADING_AT);
  if (isWindowsShellPath(input, runtime)) unsupportedPath(MSG_UNSUPPORTED_WINDOWS_SHELL_STYLE);
  if (
    input === "~" ||
    input.startsWith("~/") ||
    (runtime.platform === "win32" && input.startsWith("~\\"))
  ) {
    unsupportedPath(MSG_UNSUPPORTED_HOME_PATH);
  }
  if (/^file:\/\//.test(input)) unsupportedPath(MSG_UNSUPPORTED_FILE_URL);
  return input;
}

/** Resolve a regular absolute or relative write/edit tool path. */
export function resolveToolPath(
  target: string,
  cwd: string,
  runtime: PathRuntime,
): string {
  const normalizedTarget = normalizePath(target, runtime);
  return runtime.isAbsolute(normalizedTarget)
    ? runtime.resolve(normalizedTarget)
    : runtime.resolve(cwd, normalizedTarget);
}

/**
 * Resolve an allowWriteDir configuration entry without applying tool-input
 * normalization such as leading-`@` removal or Unicode-space replacement.
 */
export function resolveDir(spec: string, cwd: string, runtime: PathRuntime): string {
  const expanded =
    spec === "~"
      ? runtime.homeDir
      : spec.startsWith("~/") || (runtime.platform === "win32" && spec.startsWith("~\\"))
        ? runtime.join(runtime.homeDir, spec.slice(2))
        : spec;
  return runtime.isAbsolute(expanded) ? runtime.resolve(expanded) : runtime.resolve(cwd, expanded);
}

function isStrictDescendant(relativePath: string, runtime: PathRuntime): boolean {
  if (relativePath === "" || relativePath === "..") return false;
  if (relativePath.startsWith("../")) return false;
  if (runtime.platform === "win32" && relativePath.startsWith("..\\")) return false;
  return !runtime.isAbsolute(relativePath);
}

/**
 * Return true only when a write/edit target is strictly inside an allowed
 * directory. Tool target paths support only regular absolute and relative
 * paths; configured directory entries retain their existing resolution rules.
 */
export function isPathInDirs(
  target: string,
  allowedDirs: readonly string[],
  cwd: string,
  runtime: PathRuntime,
): boolean {
  if (allowedDirs.length === 0) return false;
  const targetAbs = resolveToolPath(target, cwd, runtime);
  return allowedDirs.some((spec) => {
    const dirAbs = resolveDir(spec, cwd, runtime);
    return isStrictDescendant(runtime.relative(dirAbs, targetAbs), runtime);
  });
}

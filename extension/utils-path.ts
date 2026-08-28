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
  readonly fileURLToPath: (url: string | URL) => string;
  readonly homeDir: string;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

interface NormalizePathOptions {
  readonly normalizeUnicodeSpaces?: boolean;
  readonly stripAtPrefix?: boolean;
}

/** Convert supported Windows shell drive paths to native Windows paths. */
export function normalizeWindowsShellPath(filePath: string, runtime: PathRuntime): string {
  if (
    runtime.platform !== "win32" ||
    !filePath.startsWith("/") ||
    filePath.startsWith("//") ||
    filePath.includes("\\")
  ) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

function normalizePath(
  input: string,
  runtime: PathRuntime,
  options: NormalizePathOptions = {},
): string {
  let normalized = options.normalizeUnicodeSpaces ? input.replace(UNICODE_SPACES, " ") : input;
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  normalized = normalizeWindowsShellPath(normalized, runtime);

  if (normalized === "~") return runtime.homeDir;
  if (
    normalized.startsWith("~/") ||
    (runtime.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return runtime.join(runtime.homeDir, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    return runtime.fileURLToPath(normalized);
  }
  return normalized;
}

/**
 * Resolve a write/edit tool path with Pi's resolveToCwd semantics.
 *
 * The target receives Pi's Unicode-space normalization and one leading `@`
 * removal. The base directory receives ordinary path normalization only.
 */
export function resolveToolPath(target: string, cwd: string, runtime: PathRuntime): string {
  const normalizedTarget = normalizePath(target, runtime, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
  });
  const normalizedCwd = normalizePath(cwd, runtime);
  return runtime.isAbsolute(normalizedTarget)
    ? runtime.resolve(normalizedTarget)
    : runtime.resolve(normalizedCwd, normalizedTarget);
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
 * directory. Tool target paths follow Pi's resolveToCwd behavior; configured
 * directory entries retain their literal leading `@` and Unicode whitespace.
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

/** Unit tests for platform-injected write/edit path helpers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPathInDirs as isPathInDirsWithRuntime,
  normalizeWindowsShellPath,
  resolveDir as resolveDirWithRuntime,
  resolveToolPath,
  type PathRuntime,
} from "../extension/utils-path.ts";
import { isPathInDirs } from "../extension/utils.ts";

function createRuntime(
  platform: NodeJS.Platform,
  pathApi: typeof win32 | typeof posix,
  homeDir: string,
): PathRuntime {
  return {
    platform,
    isAbsolute: pathApi.isAbsolute,
    join: pathApi.join,
    relative: pathApi.relative,
    resolve: pathApi.resolve,
    fileURLToPath: (url) => fileURLToPath(url, { windows: platform === "win32" }),
    homeDir,
  };
}

const WINDOWS_RUNTIME = createRuntime("win32", win32, "C:\\Users\\test");
const POSIX_RUNTIME = createRuntime("linux", posix, "/home/test");
const WINDOWS_CWD = "D:\\workspace\\proj";
const POSIX_CWD = "/workspace/proj";

const PATH_CASES = [
  {
    name: "win32",
    runtime: WINDOWS_RUNTIME,
    cwd: WINDOWS_CWD,
    relativeInput: "@docs\u00A0plans\\plan.md",
    relativeOutput: "D:\\workspace\\proj\\docs plans\\plan.md",
    tildeInput: "~/plans/plan.md",
    tildeOutput: "C:\\Users\\test\\plans\\plan.md",
    fileUrl: "file:///D:/workspace/proj/.agents/plans/plan.md",
    fileUrlOutput: "D:\\workspace\\proj\\.agents\\plans\\plan.md",
  },
  {
    name: "posix",
    runtime: POSIX_RUNTIME,
    cwd: POSIX_CWD,
    relativeInput: "@docs\u00A0plans/plan.md",
    relativeOutput: "/workspace/proj/docs plans/plan.md",
    tildeInput: "~/plans/plan.md",
    tildeOutput: "/home/test/plans/plan.md",
    fileUrl: "file:///workspace/proj/.agents/plans/plan.md",
    fileUrlOutput: "/workspace/proj/.agents/plans/plan.md",
  },
] as const;

test("Pi-compatible tool input rules apply on both win32 and posix platforms", () => {
  for (const pathCase of PATH_CASES) {
    assert.equal(
      resolveToolPath(pathCase.relativeInput, pathCase.cwd, pathCase.runtime),
      pathCase.relativeOutput,
      `${pathCase.name} normalizes Unicode spaces and one leading @`,
    );
    assert.equal(
      resolveToolPath(pathCase.tildeInput, pathCase.cwd, pathCase.runtime),
      pathCase.tildeOutput,
      `${pathCase.name} expands ~/`,
    );
    assert.equal(
      resolveToolPath(pathCase.fileUrl, pathCase.cwd, pathCase.runtime),
      pathCase.fileUrlOutput,
      `${pathCase.name} resolves file URLs`,
    );
  }
});

test("Windows runtime converts supported Pi shell paths only", () => {
  assert.equal(normalizeWindowsShellPath("/c/Users/test/file.md", WINDOWS_RUNTIME), "C:\\Users\\test\\file.md");
  assert.equal(normalizeWindowsShellPath("/mnt/d/work/file.md", WINDOWS_RUNTIME), "D:\\work\\file.md");
  assert.equal(normalizeWindowsShellPath("/cygdrive/e/work/file.md", WINDOWS_RUNTIME), "E:\\work\\file.md");
  assert.equal(normalizeWindowsShellPath("//server/share/file.md", WINDOWS_RUNTIME), "//server/share/file.md");
  assert.equal(normalizeWindowsShellPath("/d\\mixed/path.md", WINDOWS_RUNTIME), "/d\\mixed/path.md");

  assert.equal(
    resolveToolPath("@/mnt/d/work/plan.md", WINDOWS_CWD, WINDOWS_RUNTIME),
    "D:\\work\\plan.md",
  );
  assert.equal(
    resolveToolPath("~\\plans\\plan.md", WINDOWS_CWD, WINDOWS_RUNTIME),
    "C:\\Users\\test\\plans\\plan.md",
  );
});

test("POSIX runtime does not apply Windows-only shell path or tilde rules", () => {
  assert.equal(normalizeWindowsShellPath("/mnt/d/work/plan.md", POSIX_RUNTIME), "/mnt/d/work/plan.md");
  assert.equal(resolveToolPath("/mnt/d/work/plan.md", POSIX_CWD, POSIX_RUNTIME), "/mnt/d/work/plan.md");
  assert.equal(resolveToolPath("~\\plans\\plan.md", POSIX_CWD, POSIX_RUNTIME), "/workspace/proj/~\\plans\\plan.md");
});

test("Win32 runtime supports native paths, UNC paths, cross-drive denial, and drive-case matching", () => {
  const allowedDir = "D:\\workspace\\proj\\.agents\\plans";
  assert.equal(
    isPathInDirsWithRuntime("D:\\workspace\\proj\\.agents\\plans\\plan.md", [allowedDir], WINDOWS_CWD, WINDOWS_RUNTIME),
    true,
    "allows ordinary native backslash paths",
  );
  assert.equal(
    isPathInDirsWithRuntime("D:/workspace/proj/.agents/plans/plan.md", [allowedDir], WINDOWS_CWD, WINDOWS_RUNTIME),
    true,
    "allows ordinary native forward-slash paths",
  );
  assert.equal(
    isPathInDirsWithRuntime("d:\\workspace\\proj\\.agents\\plans\\plan.md", [allowedDir], WINDOWS_CWD, WINDOWS_RUNTIME),
    true,
    "matches drive letters case-insensitively through win32 path semantics",
  );
  assert.equal(
    isPathInDirsWithRuntime("C:\\workspace\\proj\\.agents\\plans\\plan.md", [allowedDir], WINDOWS_CWD, WINDOWS_RUNTIME),
    false,
    "rejects a target on another drive",
  );

  const uncDir = "\\\\server\\share\\proj\\plans";
  assert.equal(
    isPathInDirsWithRuntime("\\\\server\\share\\proj\\plans\\plan.md", [uncDir], WINDOWS_CWD, WINDOWS_RUNTIME),
    true,
    "allows targets below an UNC directory",
  );
  assert.equal(
    isPathInDirsWithRuntime("\\\\server\\other\\proj\\plans\\plan.md", [uncDir], WINDOWS_CWD, WINDOWS_RUNTIME),
    false,
    "rejects targets on another UNC share",
  );
});

test("allowWriteDir comparison is strict on both win32 and posix platforms", () => {
  const cases = [
    {
      name: "win32",
      runtime: WINDOWS_RUNTIME,
      cwd: WINDOWS_CWD,
      dir: "D:\\workspace\\proj\\.agents\\plans",
      child: "D:\\workspace\\proj\\.agents\\plans\\nested\\plan.md",
      parent: "D:\\workspace\\proj\\.agents",
      directChild: "D:\\workspace\\proj\\.agents\\plans\\plan.md",
      otherDirFile: "D:\\workspace\\proj\\src\\index.ts",
    },
    {
      name: "posix",
      runtime: POSIX_RUNTIME,
      cwd: POSIX_CWD,
      dir: "/workspace/proj/.agents/plans",
      child: "/workspace/proj/.agents/plans/nested/plan.md",
      parent: "/workspace/proj/.agents",
      directChild: "/workspace/proj/.agents/plans/plan.md",
      otherDirFile: "/workspace/proj/src/index.ts",
    },
  ] as const;

  for (const pathCase of cases) {
    assert.equal(
      isPathInDirsWithRuntime(pathCase.child, [pathCase.dir], pathCase.cwd, pathCase.runtime),
      true,
      `${pathCase.name} allows a strict descendant`,
    );
    assert.equal(
      isPathInDirsWithRuntime(pathCase.dir, [pathCase.dir], pathCase.cwd, pathCase.runtime),
      false,
      `${pathCase.name} rejects the allowed directory itself`,
    );
    assert.equal(
      isPathInDirsWithRuntime(pathCase.parent, [pathCase.dir], pathCase.cwd, pathCase.runtime),
      false,
      `${pathCase.name} rejects the parent directory`,
    );
    assert.equal(
      isPathInDirsWithRuntime(pathCase.directChild, [pathCase.dir], pathCase.cwd, pathCase.runtime),
      true,
      `${pathCase.name} allows a file directly in the allowed directory`,
    );
    assert.equal(
      isPathInDirsWithRuntime(pathCase.otherDirFile, [pathCase.dir], pathCase.cwd, pathCase.runtime),
      false,
      `${pathCase.name} rejects a file in another directory`,
    );
  }
});

test("allowWriteDir configuration keeps its literal @ prefix", () => {
  assert.equal(
    resolveDirWithRuntime("@plans", WINDOWS_CWD, WINDOWS_RUNTIME),
    "D:\\workspace\\proj\\@plans",
  );
  assert.equal(
    isPathInDirsWithRuntime("plans/plan.md", ["@plans"], WINDOWS_CWD, WINDOWS_RUNTIME),
    false,
  );
  assert.equal(
    isPathInDirsWithRuntime("@@plans/plan.md", ["@plans"], WINDOWS_CWD, WINDOWS_RUNTIME),
    true,
  );
});

test("path implementation is exception-transparent and public gating fails closed", () => {
  assert.throws(() => isPathInDirsWithRuntime("file:///%ZZ", ["plans"], POSIX_CWD, POSIX_RUNTIME));
  assert.equal(isPathInDirs("file:///%ZZ", ["plans"], POSIX_CWD), false);
});

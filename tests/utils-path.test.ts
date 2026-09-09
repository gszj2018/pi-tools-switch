/** Unit tests for platform-injected write/edit path helpers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { posix, win32 } from "node:path";
import {
  isPathInDirs as isPathInDirsWithRuntime,
  resolveDir as resolveDirWithRuntime,
  resolveToolPath,
  MSG_UNSUPPORTED_FILE_URL,
  MSG_UNSUPPORTED_HOME_PATH,
  MSG_UNSUPPORTED_LEADING_AT,
  MSG_UNSUPPORTED_UNICODE_SPACE,
  MSG_UNSUPPORTED_WINDOWS_SHELL_STYLE,
  type PathRuntime,
} from "../extension/utils-path.ts";

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
    relativeInput: "docs/plans/plan.md",
    relativeOutput: "D:\\workspace\\proj\\docs\\plans\\plan.md",
    absoluteInput: "D:\\workspace\\shared\\plan.md",
  },
  {
    name: "posix",
    runtime: POSIX_RUNTIME,
    cwd: POSIX_CWD,
    relativeInput: "docs/plans/plan.md",
    relativeOutput: "/workspace/proj/docs/plans/plan.md",
    absoluteInput: "/workspace/shared/plan.md",
  },
] as const;

test("regular tool paths resolve on both win32 and posix platforms", () => {
  for (const pathCase of PATH_CASES) {
    assert.equal(
      resolveToolPath(pathCase.relativeInput, pathCase.cwd, pathCase.runtime),
      pathCase.relativeOutput,
      `${pathCase.name} resolves relative paths`,
    );
    assert.equal(
      resolveToolPath(pathCase.absoluteInput, pathCase.cwd, pathCase.runtime),
      pathCase.absoluteInput,
      `${pathCase.name} resolves absolute paths`,
    );
  }
});

test("tool paths reject Pi-specific formats on both win32 and posix platforms", () => {
  const unsupportedCases = [
    { input: "docs\u00A0plans/plan.md", name: MSG_UNSUPPORTED_UNICODE_SPACE },
    { input: "@docs/plans/plan.md", name: MSG_UNSUPPORTED_LEADING_AT },
    { input: "~/plans/plan.md", name: MSG_UNSUPPORTED_HOME_PATH },
    { input: "file:///workspace/proj/.agents/plans/plan.md", name: MSG_UNSUPPORTED_FILE_URL },
  ];
  for (const pathCase of PATH_CASES) {
    for (const unsupportedCase of unsupportedCases) {
      assert.throws(
        () => resolveToolPath(unsupportedCase.input, pathCase.cwd, pathCase.runtime),
        new Error(`${unsupportedCase.name} is not supported in current mode`),
      );
    }
  }
});

test("Windows runtime rejects WSL, Cygwin, MSYS2, and backslash home paths", () => {
  for (const input of ["/c/Users/test/file.md", "/mnt/d/work/file.md", "/cygdrive/e/work/file.md"]) {
    assert.throws(
      () => resolveToolPath(input, WINDOWS_CWD, WINDOWS_RUNTIME),
      new Error(`${MSG_UNSUPPORTED_WINDOWS_SHELL_STYLE} is not supported in current mode`),
    );
  }
  assert.throws(
    () => resolveToolPath("~\\plans\\plan.md", WINDOWS_CWD, WINDOWS_RUNTIME),
    new Error(`${MSG_UNSUPPORTED_HOME_PATH} is not supported in current mode`),
  );
});

test("POSIX runtime does not reject Windows-only shell paths", () => {
  assert.equal(
    resolveToolPath("/mnt/d/work/plan.md", POSIX_CWD, POSIX_RUNTIME),
    "/mnt/d/work/plan.md",
  );
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

test("relative tool paths with dot segments are gated on both win32 and posix platforms", () => {
  const cases = [
    { name: "win32", runtime: WINDOWS_RUNTIME, cwd: WINDOWS_CWD },
    { name: "posix", runtime: POSIX_RUNTIME, cwd: POSIX_CWD },
  ] as const;

  for (const pathCase of cases) {
    assert.equal(
      isPathInDirsWithRuntime(
        ".agents/plans/nested/../plan.md",
        [".agents/plans"],
        pathCase.cwd,
        pathCase.runtime,
      ),
      true,
      `${pathCase.name} allows a relative path with .. that remains inside`,
    );
    assert.equal(
      isPathInDirsWithRuntime(
        ".agents/plans/./plan.md",
        [".agents/plans"],
        pathCase.cwd,
        pathCase.runtime,
      ),
      true,
      `${pathCase.name} allows a relative path with . inside`,
    );
    assert.equal(
      isPathInDirsWithRuntime(
        ".agents/plans/../../README.md",
        [".agents/plans"],
        pathCase.cwd,
        pathCase.runtime,
      ),
      false,
      `${pathCase.name} rejects a relative path with .. outside`,
    );
  }
});

test("resolveDir resolves configuration paths on both win32 and posix platforms", () => {
  const cases = [
    {
      name: "win32",
      runtime: WINDOWS_RUNTIME,
      cwd: WINDOWS_CWD,
      homeDir: "C:\\Users\\test",
      homeChild: "C:\\Users\\test\\plans",
      relativePath: ".agents\\plans",
      relativeOutput: "D:\\workspace\\proj\\.agents\\plans",
      absolutePath: "D:\\workspace\\shared",
    },
    {
      name: "posix",
      runtime: POSIX_RUNTIME,
      cwd: POSIX_CWD,
      homeDir: "/home/test",
      homeChild: "/home/test/plans",
      relativePath: ".agents/plans",
      relativeOutput: "/workspace/proj/.agents/plans",
      absolutePath: "/workspace/shared",
    },
  ] as const;

  for (const pathCase of cases) {
    assert.equal(resolveDirWithRuntime("~", pathCase.cwd, pathCase.runtime), pathCase.homeDir);
    assert.equal(resolveDirWithRuntime("~/plans", pathCase.cwd, pathCase.runtime), pathCase.homeChild);
    assert.equal(resolveDirWithRuntime(pathCase.relativePath, pathCase.cwd, pathCase.runtime), pathCase.relativeOutput);
    assert.equal(resolveDirWithRuntime(pathCase.absolutePath, pathCase.cwd, pathCase.runtime), pathCase.absolutePath);
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
    isPathInDirsWithRuntime(
      "D:\\workspace\\proj\\@plans\\plan.md",
      ["@plans"],
      WINDOWS_CWD,
      WINDOWS_RUNTIME,
    ),
    true,
  );
});

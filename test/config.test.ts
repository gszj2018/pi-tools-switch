/**
 * Unit tests for the config module (extension/config.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfigFrom,
  normalizeConfig,
  type Config,
  type ConfigLoadResult,
} from "../extension/config.ts";

function assertErrors(result: ConfigLoadResult, expected: string[]): void {
  assert.equal(
    result.errors.length,
    expected.length,
    `expected ${expected.length} errors, got ${JSON.stringify(result.errors)}`,
  );
  for (const e of expected) {
    assert.ok(result.errors.includes(e), `missing error: ${e}`);
  }
}

/** Field-level assertion for a fully defaulted config (defaultPreset key may be undefined). */
function assertDefaultConfig(config: Config): void {
  assert.deepEqual(config.presets, {});
  assert.equal(config.toolGuide.enabled, true);
  assert.deepEqual(config.subagentEnvVars, []);
  assert.deepEqual(config.gatingModes, {});
  assert.equal(config.defaultPreset, undefined);
}

/** Remove the config file (if present) and the empty temp dir, avoiding recursive removal. */
async function cleanupTempDir(dir: string): Promise<void> {
  await unlink(join(dir, CONFIG_FILE_NAME)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await rmdir(dir);
}

test("normalizeConfig({}) returns defaults with no errors", () => {
  const r = normalizeConfig({});
  assert.deepEqual(r.config.presets, {});
  assert.equal(r.config.toolGuide.enabled, true);
  assert.deepEqual(r.config.subagentEnvVars, []);
  assert.deepEqual(r.config.gatingModes, {});
  assert.equal(r.config.defaultPreset, undefined);
  assert.deepEqual(r.errors, []);
});

test("normalizeConfig(non-object) reports an error and returns defaults", () => {
  const r = normalizeConfig([1, 2]);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
  assertErrors(r, ["config: expected an object, got object"]);
});

test("normalizeConfig(valid example) normalizes and stays clean", () => {
  const r = normalizeConfig({
    presets: { "my-preset": ["read", "grep"] },
    defaultPreset: "my-preset",
    toolGuide: { enabled: false },
    subagentEnvVars: ["PI_SUBAGENT"],
    gatingModes: {
      "plan-mode": { trigger: "/skill:plan-mode", allowTools: [], allowWriteDir: [".agents/plans"] },
    },
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config.presets["my-preset"], ["read", "grep"]);
  assert.equal(r.config.defaultPreset, "my-preset");
  assert.equal(r.config.toolGuide.enabled, false);
  assert.deepEqual(r.config.subagentEnvVars, ["PI_SUBAGENT"]);
  assert.deepEqual(r.config.gatingModes["plan-mode"], {
    trigger: "/skill:plan-mode",
    allowTools: [],
    allowWriteDir: [".agents/plans"],
  });
});

test("normalizeConfig drops invalid preset entries and dedupes tools", () => {
  const r = normalizeConfig({
    presets: {
      "my-preset": ["read", "grep", "read", "bogus", 42],
      UPPER: ["read"],
      notarray: "read",
    },
  });
  assert.deepEqual(r.config.presets["my-preset"], ["read", "grep"]);
  assert.equal(r.config.presets["UPPER"], undefined);
  assert.equal(r.config.presets["notarray"], undefined);
  assertErrors(r, [
    'presets["my-preset"]: ignored unknown tool "bogus"',
    "presets[\"my-preset\"]: ignored unknown tool 42",
    'presets["UPPER"]: invalid preset name (must match [a-z][a-z0-9_-]*)',
    'presets["notarray"]: expected an array of tool names, got string',
  ]);
});

test("normalizeConfig rejects invalid defaultPreset", () => {
  const r = normalizeConfig({ defaultPreset: "Bad_Name" });
  assert.equal(r.config.defaultPreset, undefined);
  assertErrors(r, ["defaultPreset: must be a string matching [a-z][a-z0-9_-]*"]);
});

test("normalizeConfig validates toolGuide", () => {
  const nonObject = normalizeConfig({ toolGuide: "yes" });
  assert.equal(nonObject.config.toolGuide.enabled, true);
  assertErrors(nonObject, ["toolGuide: expected an object, got string"]);

  const nonBoolean = normalizeConfig({ toolGuide: { enabled: "yes" } });
  assert.equal(nonBoolean.config.toolGuide.enabled, true);
  assertErrors(nonBoolean, ["toolGuide.enabled: expected a boolean, got string"]);
});

test("normalizeConfig validates subagentEnvVars", () => {
  const nonArray = normalizeConfig({ subagentEnvVars: "PI_SUBAGENT" });
  assert.deepEqual(nonArray.config.subagentEnvVars, []);
  assertErrors(nonArray, ["subagentEnvVars: expected an array of strings, got string"]);

  const badEntries = normalizeConfig({ subagentEnvVars: ["OK", 7, null] });
  assert.deepEqual(badEntries.config.subagentEnvVars, ["OK"]);
  assertErrors(badEntries, [
    "subagentEnvVars: ignored non-string entry 7",
    "subagentEnvVars: ignored non-string entry null",
  ]);
});

test("normalizeConfig validates gatingModes", () => {
  const r = normalizeConfig({
    gatingModes: {
      "bad-trigger": { trigger: "" },
      number: 42,
      ok: { trigger: "/x", allowTools: "nope", allowWriteDir: { a: 1 } },
      mixed: { trigger: "/y", allowTools: ["read", 3], allowWriteDir: [".a", false] },
    },
  });
  assert.equal(r.config.gatingModes["bad-trigger"], undefined);
  assert.equal(r.config.gatingModes["number"], undefined);
  assert.deepEqual(r.config.gatingModes["ok"], { trigger: "/x", allowTools: [], allowWriteDir: [] });
  assert.deepEqual(r.config.gatingModes["mixed"].allowTools, ["read"]);
  assert.deepEqual(r.config.gatingModes["mixed"].allowWriteDir, [".a"]);
  assertErrors(r, [
    'gatingModes["bad-trigger"]: missing or empty trigger',
    'gatingModes["number"]: expected an object, got number',
    'gatingModes["ok"].allowTools: expected an array of strings, got string',
    'gatingModes["ok"].allowWriteDir: expected an array of strings, got object',
    'gatingModes["mixed"].allowTools: ignored non-string entry 3',
    'gatingModes["mixed"].allowWriteDir: ignored non-string entry false',
  ]);
});

test("loadConfigFrom creates an empty config when the file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsw-test-"));
  try {
    const r = await loadConfigFrom(dir);
    assertDefaultConfig(r.config);
    assert.deepEqual(r.errors, []);
    const raw = await readFile(join(dir, CONFIG_FILE_NAME), "utf8");
    assert.equal(raw.trim(), "{}");
  } finally {
    await cleanupTempDir(dir);
  }
});

test("loadConfigFrom treats 0-byte and whitespace-only files as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsw-test-"));
  try {
    await writeFile(join(dir, CONFIG_FILE_NAME), "");
    const r1 = await loadConfigFrom(dir);
    assertDefaultConfig(r1.config);
    assert.equal((await readFile(join(dir, CONFIG_FILE_NAME), "utf8")).trim(), "{}");

    await writeFile(join(dir, CONFIG_FILE_NAME), "  \n\t ");
    const r2 = await loadConfigFrom(dir);
    assertDefaultConfig(r2.config);
    assert.equal((await readFile(join(dir, CONFIG_FILE_NAME), "utf8")).trim(), "{}");
  } finally {
    await cleanupTempDir(dir);
  }
});

test("loadConfigFrom parses a valid file and surfaces config errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsw-test-"));
  try {
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ defaultPreset: "read" }));
    const r = await loadConfigFrom(dir);
    assert.equal(r.config.defaultPreset, "read");
    assert.deepEqual(r.errors, []);

    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ defaultPreset: 123 }));
    const r2 = await loadConfigFrom(dir);
    assert.equal(r2.config.defaultPreset, undefined);
    assertErrors(r2, ["defaultPreset: must be a string matching [a-z][a-z0-9_-]*"]);
  } finally {
    await cleanupTempDir(dir);
  }
});

test("loadConfigFrom throws on malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsw-test-"));
  try {
    await writeFile(join(dir, CONFIG_FILE_NAME), "{ oops");
    await assert.rejects(() => loadConfigFrom(dir), /Invalid JSON in/);
  } finally {
    await cleanupTempDir(dir);
  }
});

test("config objects are deeply frozen", () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  const r = normalizeConfig({
    presets: { p: ["read"] },
    gatingModes: {
      m: { trigger: "/x", allowTools: ["read"], allowWriteDir: [] },
    },
  });
  assert.ok(Object.isFrozen(r.config));
  assert.ok(Object.isFrozen(r.config.presets));
  assert.ok(Object.isFrozen(r.config.presets["p"]));
  assert.ok(Object.isFrozen(r.config.gatingModes["m"]));
  assert.ok(Object.isFrozen(r.config.gatingModes["m"].allowTools));
  assert.ok(Object.isFrozen(r.config.subagentEnvVars));
  // Mutation attempts throw in strict mode.
  assert.throws(() => {
    (r.config.subagentEnvVars as string[]).push("PI_X");
  }, TypeError);
  assert.throws(() => {
    (r.config.presets as Record<string, string[]>)["new"] = ["read"];
  }, TypeError);
});

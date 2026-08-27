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

/** Field-level assertion for a fully defaulted config. */
function assertDefaultConfig(config: Config): void {
  assert.deepEqual(config.presets, {});
  assert.deepEqual(config.subagentEnvVars, []);
  assert.deepEqual(config.gatingModes, {});
  // Empty here: the built-in exit trigger (defined in tool-gating.ts) applies
  // when the config provides none.
  assert.deepEqual(config.gatingExitTrigger, []);
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
  assert.deepEqual(r.config.subagentEnvVars, []);
  assert.deepEqual(r.config.gatingModes, {});
  assert.deepEqual(r.config.gatingExitTrigger, []);
  assert.deepEqual(r.errors, []);
});

test("normalizeConfig(non-object) reports an error and returns defaults", () => {
  const r = normalizeConfig([1, 2]);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
  assertErrors(r, ["config: expected an object, got object"]);
});

test("normalizeConfig(valid example) normalizes and stays clean", () => {
  const r = normalizeConfig({
    presets: { "my-preset": ["read", "powershell", "grep"] },
    subagentEnvVars: ["PI_SUBAGENT"],
    gatingModes: {
      "plan-mode": {
        trigger: ["/skill:plan-mode", "PLAN:"],
        allowTools: [],
        allowWriteDir: [".agents/plans"],
      },
    },
    gatingExitTrigger: ["/skill:normal-mode", "EXIT:"],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config.presets["my-preset"], ["read", "powershell", "grep"]);
  assert.deepEqual(r.config.subagentEnvVars, ["PI_SUBAGENT"]);
  assert.deepEqual(r.config.gatingModes["plan-mode"], {
    trigger: ["/skill:plan-mode", "PLAN:"],
    allowTools: [],
    allowWriteDir: [".agents/plans"],
  });
  assert.deepEqual(r.config.gatingExitTrigger, ["/skill:normal-mode", "EXIT:"]);
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
      "no-trigger": { allowTools: [], allowWriteDir: [] },
      "empty-triggers": { trigger: [], allowTools: [], allowWriteDir: [] },
      "blank-trigger": { trigger: [""], allowTools: [], allowWriteDir: [] },
      "legacy-trigger": { trigger: "PLAN:", allowTools: [], allowWriteDir: [] },
      number: 42,
      ok: { trigger: ["READ:", "EXPLORE:"], allowTools: "nope", allowWriteDir: { a: 1 } },
      mixed: { trigger: ["READ:", "", 3], allowTools: ["read", 3], allowWriteDir: [".a", false] },
    },
  });
  assert.equal(r.config.gatingModes["no-trigger"], undefined);
  assert.equal(r.config.gatingModes["empty-triggers"], undefined);
  assert.equal(r.config.gatingModes["blank-trigger"], undefined);
  assert.equal(r.config.gatingModes["legacy-trigger"], undefined);
  assert.equal(r.config.gatingModes["number"], undefined);
  assert.deepEqual(r.config.gatingModes["ok"], { trigger: ["READ:", "EXPLORE:"], allowTools: [], allowWriteDir: [] });
  assert.deepEqual(r.config.gatingModes["mixed"], { trigger: ["READ:"], allowTools: ["read"], allowWriteDir: [".a"] });
  assertErrors(r, [
    'gatingModes["no-trigger"]: missing or empty trigger',
    'gatingModes["empty-triggers"]: missing or empty trigger',
    'gatingModes["blank-trigger"].trigger: empty trigger prefix is not allowed',
    'gatingModes["blank-trigger"]: missing or empty trigger',
    'gatingModes["legacy-trigger"].trigger: expected an array of non-empty trigger strings (e.g. ["/plan-mode"])',
    'gatingModes["legacy-trigger"]: missing or empty trigger',
    'gatingModes["number"]: expected an object, got number',
    'gatingModes["ok"].allowTools: expected an array of strings, got string',
    'gatingModes["ok"].allowWriteDir: expected an array of strings, got object',
    'gatingModes["mixed"].trigger: empty trigger prefix is not allowed',
    'gatingModes["mixed"].trigger: ignored non-string entry 3',
    'gatingModes["mixed"].allowTools: ignored non-string entry 3',
    'gatingModes["mixed"].allowWriteDir: ignored non-string entry false',
  ]);
});

test("normalizeConfig leaves gatingExitTrigger empty when absent", () => {
  const r = normalizeConfig({});
  assert.deepEqual(r.config.gatingExitTrigger, []);
  assert.deepEqual(r.errors, []);
});

test("normalizeConfig validates gatingExitTrigger", () => {
  const ok = normalizeConfig({ gatingExitTrigger: ["EXIT:", "STOP:"] });
  assert.deepEqual(ok.config.gatingExitTrigger, ["EXIT:", "STOP:"]);
  assert.deepEqual(ok.errors, []);

  // An empty list is valid: the built-in exit trigger applies at merge time.
  const empty = normalizeConfig({ gatingExitTrigger: [] });
  assert.deepEqual(empty.config.gatingExitTrigger, []);
  assert.deepEqual(empty.errors, []);

  const blank = normalizeConfig({ gatingExitTrigger: ["", "  ", "OK:"] });
  assert.deepEqual(blank.config.gatingExitTrigger, ["OK:"]);
  assertErrors(blank, [
    "gatingExitTrigger: empty trigger prefix is not allowed",
    "gatingExitTrigger: empty trigger prefix is not allowed",
  ]);

  // All-blank entries: reported, result empty (built-in applies), and no
  // "must contain at least one non-empty trigger prefix" summary error.
  const allBlank = normalizeConfig({ gatingExitTrigger: ["", "  "] });
  assert.deepEqual(allBlank.config.gatingExitTrigger, []);
  assertErrors(allBlank, [
    "gatingExitTrigger: empty trigger prefix is not allowed",
    "gatingExitTrigger: empty trigger prefix is not allowed",
  ]);

  const nonArray = normalizeConfig({ gatingExitTrigger: "EXIT:" });
  assert.deepEqual(nonArray.config.gatingExitTrigger, []);
  assertErrors(nonArray, [
    'gatingExitTrigger: expected an array of non-empty trigger strings (e.g. ["/plan-mode"])',
  ]);

  const mixed = normalizeConfig({ gatingExitTrigger: ["EXIT:", 7] });
  assert.deepEqual(mixed.config.gatingExitTrigger, ["EXIT:"]);
  assertErrors(mixed, ["gatingExitTrigger: ignored non-string entry 7"]);
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
      m: { trigger: ["X:"], allowTools: ["read"], allowWriteDir: [] },
    },
  });
  assert.ok(Object.isFrozen(r.config));
  assert.ok(Object.isFrozen(r.config.presets));
  assert.ok(Object.isFrozen(r.config.presets["p"]));
  assert.ok(Object.isFrozen(r.config.gatingModes["m"]));
  assert.ok(Object.isFrozen(r.config.gatingModes["m"].allowTools));
  assert.ok(Object.isFrozen(r.config.subagentEnvVars));
  assert.ok(Object.isFrozen(r.config.gatingExitTrigger));
  // Mutation attempts throw in strict mode.
  assert.throws(() => {
    (r.config.subagentEnvVars as string[]).push("PI_X");
  }, TypeError);
  assert.throws(() => {
    (r.config.presets as Record<string, string[]>)["new"] = ["read"];
  }, TypeError);
});

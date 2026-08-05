/**
 * Unit tests for built-in tool state management (extension/builtin-tools.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SUBAGENT_ENV_VARS,
  getEffectiveDefaultPreset,
  isSubagentEnv,
  mergePresets,
  toggleBuiltinTools,
  toolsSwitchCompletions,
  validateBuiltinTools,
} from "../extension/builtin-tools.ts";

test("BUILTIN_SUBAGENT_ENV_VARS covers the documented subagent frameworks", () => {
  const expected = [
    "PI_IS_SUBAGENT",
    "PI_SUBAGENT_SESSION_ID",
    "PI_AGENT_ROUTER_SUBAGENT",
    "PI_SUBAGENT_CHILD",
    "PI_SUBAGENT_RUN_ID",
    "PI_SUBAGENT_CHILD_AGENT",
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_SESSION",
    "PI_SUBAGENT_ACTIVITY_FILE",
  ];
  assert.deepEqual([...BUILTIN_SUBAGENT_ENV_VARS].sort(), expected.sort());
});

test("isSubagentEnv detects built-in vars", () => {
  assert.equal(isSubagentEnv({}, []), false);
  assert.equal(isSubagentEnv({ PI_IS_SUBAGENT: "1" }, []), true);
  assert.equal(isSubagentEnv({ PI_SUBAGENT_SESSION_ID: "abc" }, []), true);
  assert.equal(isSubagentEnv({ PI_SUBAGENT_ACTIVITY_FILE: "/tmp/x.json" }, []), true);
});

test("isSubagentEnv treats empty-string values as not set", () => {
  assert.equal(isSubagentEnv({ PI_IS_SUBAGENT: "" }, []), false);
  assert.equal(isSubagentEnv({ PI_SUBAGENT_RUN_ID: "" }, []), false);
});

test("isSubagentEnv honors extra user vars on top of the built-in list", () => {
  assert.equal(isSubagentEnv({ PI_SUBAGENT: "1" }, []), false);
  assert.equal(isSubagentEnv({ PI_SUBAGENT: "1" }, ["PI_SUBAGENT"]), true);
  assert.equal(isSubagentEnv({ MY_SUBAGENT_VAR: "1" }, ["MY_SUBAGENT_VAR"]), true);
});

test("toggleBuiltinTools enables and disables a single built-in tool", () => {
  assert.deepEqual(toggleBuiltinTools([], ["read"], true), ["read"]);
  assert.deepEqual(toggleBuiltinTools(["read"], ["read"], true), ["read"]);
  assert.deepEqual(toggleBuiltinTools(["read", "bash"], ["read"], false), ["bash"]);
  assert.deepEqual(toggleBuiltinTools(["read"], ["bash"], false), ["read"]);
});

test("toggleBuiltinTools preserves external tools", () => {
  assert.deepEqual(toggleBuiltinTools(["my_custom_tool"], ["read"], true), ["my_custom_tool", "read"]);
  assert.deepEqual(toggleBuiltinTools(["read", "my_custom_tool"], ["read"], false), ["my_custom_tool"]);
});

test("toggleBuiltinTools toggles multiple tools at once", () => {
  assert.deepEqual(toggleBuiltinTools([], ["read", "grep", "ls"], true), ["read", "grep", "ls"]);
  assert.deepEqual(toggleBuiltinTools(["read", "write", "edit", "bash"], ["write", "edit"], false), [
    "read",
    "bash",
  ]);
});

test("toggleBuiltinTools dedupes repeated tools and keeps external tools", () => {
  const next = toggleBuiltinTools(["my_custom_tool"], ["read", "read", "grep"], true);
  assert.deepEqual(next, ["my_custom_tool", "read", "grep"]);
  const disabled = toggleBuiltinTools(["read", "grep", "ls"], ["grep", "grep", "ls"], false);
  assert.deepEqual(disabled, ["read"]);
});

test("validateBuiltinTools accepts only valid lists", () => {
  const ok = validateBuiltinTools(["read", "bash", "grep"]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tools, ["read", "bash", "grep"]);
  assert.deepEqual(ok.invalid, []);
});

test("validateBuiltinTools reports invalid names and keeps valid ones", () => {
  const mixed = validateBuiltinTools(["read", "bogus", "bash", "nope"]);
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.tools, ["read", "bash"]);
  assert.deepEqual(mixed.invalid, ["bogus", "nope"]);
});

test("validateBuiltinTools handles empty and all-invalid lists", () => {
  assert.deepEqual(validateBuiltinTools([]), { ok: true, tools: [], invalid: [] });
  const allInvalid = validateBuiltinTools(["nope", "wat"]);
  assert.equal(allInvalid.ok, false);
  assert.deepEqual(allInvalid.tools, []);
  assert.deepEqual(allInvalid.invalid, ["nope", "wat"]);
});

test("toolsSwitchCompletions suggests subcommands with trailing space", () => {
  const items = toolsSwitchCompletions("");
  assert.deepEqual(
    items?.map((i) => i.value),
    ["enable ", "disable ", "default "],
  );
  const partial = toolsSwitchCompletions("dis");
  assert.deepEqual(partial?.map((i) => i.value), ["disable "]);
  const invalid = toolsSwitchCompletions("foo");
  assert.equal(invalid, null);
});

test("toolsSwitchCompletions selects a subcommand then completes tool names", () => {
  // Select "enable " -> next pass must fall through to the tool-name stage.
  const afterSelect = toolsSwitchCompletions("enable ");
  assert.ok(afterSelect && afterSelect.length === 7, "tool names offered after subcommand");
  assert.deepEqual(afterSelect[0], { value: "enable read", label: "read" });

  const partial = toolsSwitchCompletions("enable r");
  assert.deepEqual(partial, [{ value: "enable read", label: "read" }]);

  const disable = toolsSwitchCompletions("disable g");
  assert.deepEqual(disable, [{ value: "disable grep", label: "grep" }]);
});

test("toolsSwitchCompletions handles edge prefixes", () => {
  // Full subcommand typed without space still suggests the spaced value.
  const typed = toolsSwitchCompletions("enable");
  assert.deepEqual(typed?.map((i) => i.value), ["enable "]);
  // Subcommand-like but not valid.
  assert.equal(toolsSwitchCompletions("enablex"), null);
  // Unknown subcommand with a second word.
  assert.equal(toolsSwitchCompletions("foo bar"), null);
  // No tool matches.
  assert.equal(toolsSwitchCompletions("enable readx"), null);
});

test("toolsSwitchCompletions suggests the default subcommand", () => {
  const items = toolsSwitchCompletions("def");
  assert.deepEqual(items, [{ value: "default ", label: "default" }]);
});

test("getEffectiveDefaultPreset returns the preset only when effective", () => {
  const presets = mergePresets({ explore: ["read", "find", "grep", "ls"] });
  assert.deepEqual(getEffectiveDefaultPreset("explore", presets, false), {
    preset: "explore",
    invalid: false,
  });
  // Subagent skips even when configured.
  assert.deepEqual(getEffectiveDefaultPreset("explore", presets, true), {
    preset: undefined,
    invalid: false,
  });
  // Not configured.
  assert.deepEqual(getEffectiveDefaultPreset(undefined, presets, false), {
    preset: undefined,
    invalid: false,
  });
  // Configured but the preset does not exist -> invalid.
  assert.deepEqual(getEffectiveDefaultPreset("nope", presets, false), {
    preset: undefined,
    invalid: true,
  });
  // Built-in preset works too.
  assert.deepEqual(getEffectiveDefaultPreset("read", presets, false), {
    preset: "read",
    invalid: false,
  });
});

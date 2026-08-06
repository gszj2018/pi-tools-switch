/**
 * Unit tests for built-in tool state management (extension/builtin-tools.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getEffectiveDefaultPreset,
  mergePresets,
  toggleBuiltinTools,
  toolsSwitchCompletions,
  validateBuiltinTools,
} from "../extension/builtin-tools.ts";

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

test("toolsSwitchCompletions suggests subcommands with appropriate spacing", () => {
  const items = toolsSwitchCompletions("");
  assert.deepEqual(items?.map((i) => i.value), ["enable ", "disable ", "default"]);
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

test("toolsSwitchCompletions supports appending multiple tools", () => {
  // After selecting one tool, further completions accumulate the full list.
  const afterFirst = toolsSwitchCompletions("enable read ");
  assert.equal(afterFirst?.length, 6);
  assert.ok(!afterFirst?.some((i) => i.label === "read"), "already-selected tool excluded");
  assert.deepEqual(afterFirst?.[0], { value: "enable read write", label: "write" });

  const partial = toolsSwitchCompletions("enable read w");
  assert.deepEqual(partial, [{ value: "enable read write", label: "write" }]);

  // Complete tool name without a trailing space -> single-tool completion only.
  const noSpace = toolsSwitchCompletions("enable read");
  assert.deepEqual(noSpace, [{ value: "enable read", label: "read" }]);
  // Multi-tool: last complete tool without a trailing space keeps earlier
  // tools in the accumulated value (still no appends).
  assert.deepEqual(toolsSwitchCompletions("enable read write"), [
    { value: "enable read write", label: "write" },
  ]);
  // With a trailing space -> append remaining tools.
  const appendMore = toolsSwitchCompletions("enable read write ");
  assert.ok(appendMore?.some((i) => i.value === "enable read write bash"));
  assert.ok(!appendMore?.some((i) => i.label === "read" || i.label === "write"));

  // All tools selected -> no more suggestions.
  assert.equal(toolsSwitchCompletions("enable read write edit bash find grep ls "), null);
});

test("toolsSwitchCompletions handles edge prefixes", () => {
  // Full subcommand typed without space still suggests the spaced value.
  const typed = toolsSwitchCompletions("enable");
  assert.deepEqual(typed?.map((i) => i.value), ["enable "]);
  // Subcommand-like but not valid.
  assert.equal(toolsSwitchCompletions("enablex"), null);
  // Unknown subcommand with a second word.
  assert.equal(toolsSwitchCompletions("foo bar"), null);
  // Unknown tool name typed after a valid subcommand.
  assert.equal(toolsSwitchCompletions("enable readx"), null);
});

test("toolsSwitchCompletions suggests the default subcommand without trailing space", () => {
  const items = toolsSwitchCompletions("def");
  assert.deepEqual(items, [{ value: "default", label: "default" }]);
});

test("getEffectiveDefaultPreset returns the preset only when effective", () => {
  const presets = mergePresets({ explore: ["read", "find", "grep", "ls"] });
  assert.deepEqual(getEffectiveDefaultPreset("explore", presets), {
    preset: "explore",
    configured: "explore",
    invalid: false,
  });
  // Not configured.
  assert.deepEqual(getEffectiveDefaultPreset(undefined, presets), {
    preset: undefined,
    configured: undefined,
    invalid: false,
  });
  // Configured but the preset does not exist -> invalid.
  assert.deepEqual(getEffectiveDefaultPreset("nope", presets), {
    preset: undefined,
    configured: "nope",
    invalid: true,
  });
  // Built-in preset works too.
  assert.deepEqual(getEffectiveDefaultPreset("read", presets), {
    preset: "read",
    configured: "read",
    invalid: false,
  });
});

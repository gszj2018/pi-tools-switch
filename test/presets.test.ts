/**
 * Unit tests for tool presets (extension/builtin-tools.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PRESETS,
  applyPreset,
  mergePresets,
} from "../extension/builtin-tools.ts";

test("BUILTIN_PRESETS match the documented presets", () => {
  assert.deepEqual(BUILTIN_PRESETS["read"], ["read"]);
  assert.deepEqual(BUILTIN_PRESETS["explore"], ["read", "find", "grep", "ls"]);
  assert.deepEqual(BUILTIN_PRESETS["default"], ["read", "write", "edit", "bash"]);
  assert.deepEqual(BUILTIN_PRESETS["full"], ["read", "write", "edit", "bash", "find", "grep", "ls"]);
  for (const tools of Object.values(BUILTIN_PRESETS)) {
    assert.ok(!tools.includes("powershell"));
  }
});

test("mergePresets keeps built-ins and adds user presets", () => {
  const merged = mergePresets({ mine: ["read", "grep"] });
  assert.deepEqual(merged["read"], ["read"]);
  assert.deepEqual(merged["explore"], ["read", "find", "grep", "ls"]);
  assert.deepEqual(merged["mine"], ["read", "grep"]);
});

test("mergePresets lets user presets override built-ins of the same name", () => {
  const merged = mergePresets({ explore: ["read", "bash"] });
  assert.deepEqual(merged["explore"], ["read", "bash"]);
  assert.notDeepEqual(merged["explore"], BUILTIN_PRESETS["explore"]);
});

test("mergePresets does not mutate the built-in presets", () => {
  mergePresets({ explore: ["read", "bash"] });
  assert.deepEqual(BUILTIN_PRESETS["explore"], ["read", "find", "grep", "ls"]);
});

test("applyPreset replaces built-in tools while keeping external tools", () => {
  const active = ["read", "write", "edit", "bash", "my_custom_tool"];
  const next = applyPreset(active, ["read", "find", "grep", "ls"]);
  assert.deepEqual(next, ["my_custom_tool", "read", "find", "grep", "ls"]);
});

test("applyPreset removes managed built-ins not in the preset", () => {
  const active = ["read", "write", "edit", "bash", "powershell", "find", "grep", "ls"];
  const next = applyPreset(active, ["read"]);
  assert.deepEqual(next, ["read"]);
});

test("applyPreset dedupes preset tools and keeps order", () => {
  const active: string[] = [];
  const next = applyPreset(active, ["read", "grep", "read"]);
  assert.deepEqual(next, ["read", "grep"]);
});

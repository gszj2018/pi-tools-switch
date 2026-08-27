/**
 * Unit tests for built-in tool state management (extension/builtin-tools.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  builtinToolCompletions,
  toggleBuiltinTools,
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

test("builtinToolCompletions suggests built-in tools for empty and partial prefixes", () => {
  const items = builtinToolCompletions("");
  assert.deepEqual(items?.map((item) => item.value), [
    "read",
    "write",
    "edit",
    "bash",
    "find",
    "grep",
    "ls",
  ]);
  assert.deepEqual(builtinToolCompletions("r"), [{ value: "read", label: "read" }]);
  assert.equal(builtinToolCompletions("unknown"), null);
});

test("builtinToolCompletions requires trailing space before appending tools", () => {
  assert.deepEqual(builtinToolCompletions("read"), [{ value: "read", label: "read" }]);

  const append = builtinToolCompletions("read ");
  assert.equal(append?.length, 6);
  assert.ok(!append?.some((item) => item.label === "read"));
  assert.deepEqual(append?.[0], { value: "read write", label: "write" });
});

test("builtinToolCompletions accumulates multiple tool arguments", () => {
  assert.deepEqual(builtinToolCompletions("read w"), [
    { value: "read write", label: "write" },
  ]);
  assert.deepEqual(builtinToolCompletions("read write"), [
    { value: "read write", label: "write" },
  ]);

  const append = builtinToolCompletions("read write ");
  assert.ok(append?.some((item) => item.value === "read write edit"));
  assert.ok(!append?.some((item) => item.label === "read" || item.label === "write"));
});

test("builtinToolCompletions rejects invalid completed tokens and stops when exhausted", () => {
  assert.equal(builtinToolCompletions("readx write "), null);
  assert.equal(builtinToolCompletions("read write edit bash find grep ls "), null);
});

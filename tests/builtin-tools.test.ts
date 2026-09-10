/**
 * Unit tests for built-in tool state management (extension/builtin-tools.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  builtinToolCompletions,
  getToolStatus,
  toggleBuiltinTools,
  validateBuiltinTools,
} from "../extension/builtin-tools.ts";

test("getToolStatus returns a fresh immutable tool-state snapshot", () => {
  let activeTools = ["read", "external_tool"];
  let allTools = [{ name: "read" }, { name: "write" }, { name: "external_tool" }];

  const snapshot = getToolStatus(activeTools, allTools);
  assert.deepEqual(snapshot, [
    { name: "read", enabled: true, builtIn: true },
    { name: "write", enabled: false, builtIn: true },
    { name: "external_tool", enabled: true, builtIn: false },
  ]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot[0]));
  assert.notEqual(getToolStatus(activeTools, allTools), snapshot);
  assert.throws(() =>
    (snapshot as unknown as { enabled: boolean }[]).push({ enabled: false }),
  );
  assert.throws(() => {
    (snapshot[0] as { enabled: boolean }).enabled = false;
  });

  activeTools = ["write"];
  allTools = [{ name: "write" }];
  assert.deepEqual(snapshot, [
    { name: "read", enabled: true, builtIn: true },
    { name: "write", enabled: false, builtIn: true },
    { name: "external_tool", enabled: true, builtIn: false },
  ]);
  assert.deepEqual(getToolStatus(activeTools, allTools), [{ name: "write", enabled: true, builtIn: true }]);
});

test("toggleBuiltinTools enables and disables a single built-in tool", () => {
  assert.deepEqual(toggleBuiltinTools([], ["read"], true), ["read"]);
  assert.deepEqual(toggleBuiltinTools(["read"], ["read"], true), ["read"]);
  assert.deepEqual(toggleBuiltinTools(["read", "powershell"], ["read"], false), ["powershell"]);
  assert.deepEqual(toggleBuiltinTools(["read"], ["powershell"], false), ["read"]);
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

test("toggleBuiltinTools dedupes initial tools without mutating inputs or changing first-seen order", () => {
  const activeTools = Object.freeze(["read", "external_tool", "read", "external_tool", "bash"]);
  const tools = ["read", "grep", "read", "grep"] as const;
  assert.deepEqual(toggleBuiltinTools(activeTools, tools, true), ["read", "external_tool", "bash", "grep"]);
  assert.deepEqual(toggleBuiltinTools(activeTools, tools, false), ["external_tool", "bash"]);
  assert.deepEqual(activeTools, ["read", "external_tool", "read", "external_tool", "bash"]);
  assert.deepEqual(tools, ["read", "grep", "read", "grep"]);
});

test("validateBuiltinTools accepts only valid lists", () => {
  const ok = validateBuiltinTools(["read", "bash", "powershell", "grep"]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tools, ["read", "bash", "powershell", "grep"]);
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
    "powershell",
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
  assert.equal(append?.length, 7);
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
  assert.equal(builtinToolCompletions("read write edit bash powershell find grep ls "), null);
});

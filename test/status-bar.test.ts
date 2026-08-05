/**
 * Unit tests for status bar rendering (extension/builtin-tools.ts,
 * extension/system-prompt.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeStatusBar,
  formatDefaultStatus,
  formatPresetLine,
  formatToolsStatus,
} from "../extension/builtin-tools.ts";
import { formatSplStatus } from "../extension/system-prompt.ts";

test("computeStatusBar renders [RWEBFGL] when all built-in tools are active", () => {
  assert.equal(computeStatusBar(["read", "write", "edit", "bash", "find", "grep", "ls"]), "[RWEBFGL]");
});

test("computeStatusBar renders all dashes when no built-in tool is active", () => {
  assert.equal(computeStatusBar([]), "[-------]");
  assert.equal(computeStatusBar(["external-tool"]), "[-------]");
});

test("computeStatusBar renders partial states in fixed order", () => {
  assert.equal(computeStatusBar(["read"]), "[R------]");
  assert.equal(computeStatusBar(["read", "find", "grep", "ls"]), "[R---FGL]");
  assert.equal(computeStatusBar(["read", "write", "edit", "bash"]), "[RWEB---]");
  assert.equal(computeStatusBar(["bash", "read"]), "[R--B---]");
});

test("computeStatusBar ignores non-built-in tools", () => {
  assert.equal(computeStatusBar(["read", "my_custom_tool"]), "[R------]");
  assert.equal(computeStatusBar(["read", "read"]), "[R------]");
});

test("formatPresetLine includes name and shorthand", () => {
  assert.equal(formatPresetLine("read", ["read"]), "[R------] read");
  assert.equal(formatPresetLine("explore", ["read", "find", "grep", "ls"]), "[R---FGL] explore");
  assert.equal(
    formatPresetLine("full", ["read", "write", "edit", "bash", "find", "grep", "ls"]),
    "[RWEBFGL] full",
  );
});

test("formatToolsStatus marks on/off and built-in kind", () => {
  const all = [
    { name: "read" },
    { name: "bash" },
    { name: "my_custom_tool" },
  ];
  const text = formatToolsStatus(["read"], all);
  assert.equal(text, "[+] read (built-in)\n[ ] bash (built-in)\n[ ] my_custom_tool");
});

test("formatSplStatus renders the length and the session-start placeholder", () => {
  assert.equal(formatSplStatus(undefined), "[SPL: -]");
  assert.equal(formatSplStatus(0), "[SPL: 0]");
  assert.equal(formatSplStatus(1234), "[SPL: 1234]");
});

test("formatDefaultStatus renders active and inactive", () => {
  assert.equal(formatDefaultStatus(undefined), "[D: -]");
  assert.equal(formatDefaultStatus("explore"), "[D: explore]");
});

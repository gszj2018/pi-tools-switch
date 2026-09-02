/**
 * Unit tests for built-in tool status bar rendering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeStatusBar,
  formatPresetLine,
} from "../extension/builtin-tools.ts";

test("computeStatusBar renders [RWEBPFGL] when all managed built-in tools are active", () => {
  assert.equal(
    computeStatusBar(["read", "write", "edit", "bash", "powershell", "find", "grep", "ls"]),
    "[RWEBPFGL]",
  );
});

test("computeStatusBar renders all dashes when no built-in tool is active", () => {
  assert.equal(computeStatusBar([]), "[--------]");
  assert.equal(computeStatusBar(["external-tool"]), "[--------]");
});

test("computeStatusBar renders partial states in fixed order", () => {
  assert.equal(computeStatusBar(["read"]), "[R-------]");
  assert.equal(computeStatusBar(["read", "find", "grep", "ls"]), "[R----FGL]");
  assert.equal(computeStatusBar(["read", "write", "edit", "bash"]), "[RWEB----]");
  assert.equal(computeStatusBar(["powershell"]), "[----P---]");
  assert.equal(computeStatusBar(["bash", "read"]), "[R--B----]");
});

test("computeStatusBar ignores non-built-in tools", () => {
  assert.equal(computeStatusBar(["read", "my_custom_tool"]), "[R-------]");
  assert.equal(computeStatusBar(["read", "read"]), "[R-------]");
});

test("formatPresetLine includes name and shorthand", () => {
  assert.equal(formatPresetLine("read", ["read"]), "[R-------] read");
  assert.equal(formatPresetLine("explore", ["read", "find", "grep", "ls"]), "[R----FGL] explore");
  assert.equal(
    formatPresetLine("full", ["read", "write", "edit", "bash", "find", "grep", "ls"]),
    "[RWEB-FGL] full",
  );
});


/** Unit tests for the read-only tool status module. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  GatingStatusReader,
  GatingToolStatus,
  ToolStatusSnapshot,
} from "../extension/utils-status.ts";
import {
  formatToolStatus,
  getGatingStatusMarker,
} from "../extension/tool-status.ts";

const UNRESTRICTED_TOOL_STATUS: GatingToolStatus = Object.freeze({
  unrestricted: true,
  hasAllowedWriteDir: false,
});

const PATH_RESTRICTED_TOOL_STATUS: GatingToolStatus = Object.freeze({
  unrestricted: false,
  hasAllowedWriteDir: true,
});

const BLOCKED_TOOL_STATUS: GatingToolStatus = Object.freeze({
  unrestricted: false,
  hasAllowedWriteDir: false,
});

const TOOL_STATUS: readonly ToolStatusSnapshot[] = Object.freeze([
  Object.freeze({ name: "read", enabled: true, builtIn: true }),
  Object.freeze({ name: "write", enabled: false, builtIn: true }),
  Object.freeze({ name: "edit", enabled: true, builtIn: true }),
  Object.freeze({ name: "bash", enabled: true, builtIn: true }),
  Object.freeze({ name: "external_tool", enabled: true, builtIn: false }),
  Object.freeze({ name: "external_tool_allow", enabled: true, builtIn: false }),
  Object.freeze({ name: "exit_mode", enabled: true, builtIn: false }),
]);

test("getGatingStatusMarker follows the derived per-tool status", () => {
  assert.equal(getGatingStatusMarker(UNRESTRICTED_TOOL_STATUS), "[ ]");
  assert.equal(getGatingStatusMarker(PATH_RESTRICTED_TOOL_STATUS), "[*]");
  assert.equal(getGatingStatusMarker(BLOCKED_TOOL_STATUS), "[-]");
  assert.equal(
    getGatingStatusMarker({ unrestricted: true, hasAllowedWriteDir: true }),
    "[ ]",
    "unrestricted status takes precedence over an irrelevant directory flag",
  );
});

test("formatToolStatus renders enabled, gating, and built-in markers in tool order", () => {
  const unrestrictedTools = new Set(["read", "bash", "external_tool_allow", "exit_mode"]);
  const readGatingStatus: GatingStatusReader = (toolName) => {
    if (toolName === "write" || toolName === "edit") return PATH_RESTRICTED_TOOL_STATUS;
    return unrestrictedTools.has(toolName) ? UNRESTRICTED_TOOL_STATUS : BLOCKED_TOOL_STATUS;
  };

  assert.equal(
    formatToolStatus(TOOL_STATUS, readGatingStatus),
    [
      "[+][ ] read (built-in)",
      "[ ][*] write (built-in)",
      "[+][*] edit (built-in)",
      "[+][ ] bash (built-in)",
      "[+][-] external_tool",
      "[+][ ] external_tool_allow",
      "[+][ ] exit_mode",
    ].join("\n"),
  );
});


/** Unit tests for the read-only tool status module. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolStatusSnapshot } from "../extension/builtin-tools.ts";
import { EXIT_MODE_TOOL_NAME, type GatingStatusSnapshot } from "../extension/tool-gating.ts";
import {
  formatToolStatus,
  getGatingStatusMarker,
} from "../extension/tool-status.ts";

const INACTIVE_GATE: GatingStatusSnapshot = Object.freeze({
  activeModeName: null,
  allowTools: Object.freeze([]),
  allowWriteDir: Object.freeze([]),
});

const RESTRICTED_GATE: GatingStatusSnapshot = Object.freeze({
  activeModeName: "review",
  allowTools: Object.freeze(["bash", "external_tool_allow"]),
  allowWriteDir: Object.freeze(["docs"]),
});

const TOOL_STATUS: readonly ToolStatusSnapshot[] = Object.freeze([
  Object.freeze({ name: "read", enabled: true, builtIn: true }),
  Object.freeze({ name: "write", enabled: false, builtIn: true }),
  Object.freeze({ name: "edit", enabled: true, builtIn: true }),
  Object.freeze({ name: "bash", enabled: true, builtIn: true }),
  Object.freeze({ name: "external_tool", enabled: true, builtIn: false }),
  Object.freeze({ name: "external_tool_allow", enabled: true, builtIn: false }),
  Object.freeze({ name: EXIT_MODE_TOOL_NAME, enabled: true, builtIn: false }),
]);

test("getGatingStatusMarker reports unrestricted tools when no gate is active", () => {
  for (const toolName of ["read", "write", "edit", "bash", "external_tool"]) {
    assert.equal(getGatingStatusMarker(toolName, INACTIVE_GATE), "[ ]");
  }
});

test("getGatingStatusMarker follows active-gate allow and block priority", () => {
  assert.equal(getGatingStatusMarker("read", RESTRICTED_GATE), "[ ]");
  assert.equal(getGatingStatusMarker("find", RESTRICTED_GATE), "[ ]");
  assert.equal(getGatingStatusMarker(EXIT_MODE_TOOL_NAME, RESTRICTED_GATE), "[ ]");
  assert.equal(getGatingStatusMarker("bash", RESTRICTED_GATE), "[ ]");
  assert.equal(getGatingStatusMarker("write", RESTRICTED_GATE), "[*]");
  assert.equal(getGatingStatusMarker("edit", RESTRICTED_GATE), "[*]");
  assert.equal(getGatingStatusMarker("external_tool", RESTRICTED_GATE), "[-]");
  assert.equal(getGatingStatusMarker("external_tool_allow", RESTRICTED_GATE), "[ ]");
});

test("getGatingStatusMarker blocks write/edit without dirs unless explicitly allowed", () => {
  const blockedWrites: GatingStatusSnapshot = {
    activeModeName: "review",
    allowTools: [],
    allowWriteDir: [],
  };
  const allowedWrite: GatingStatusSnapshot = {
    activeModeName: "review",
    allowTools: ["write"],
    allowWriteDir: ["docs"],
  };

  assert.equal(getGatingStatusMarker("write", blockedWrites), "[-]");
  assert.equal(getGatingStatusMarker("edit", blockedWrites), "[-]");
  assert.equal(getGatingStatusMarker("write", allowedWrite), "[ ]");
});

test("formatToolStatus renders enabled, gating, and built-in markers in tool order", () => {
  assert.equal(
    formatToolStatus(TOOL_STATUS, RESTRICTED_GATE),
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


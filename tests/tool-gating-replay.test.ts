/**
 * Unit tests for replaying the last injected tool-gating mode message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MODE_MESSAGE_CUSTOM_TYPE,
  MODE_TRIGGER_CUSTOM_TYPE,
  replayLastReportedModeName,
  replayLastTriggeredModeName,
} from "../extension/tool-gating-replay.ts";

function createContext(getBranch: () => unknown[]): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => getBranch() as never,
    },
  } as unknown as ExtensionContext;
}

function modeMessage(details?: unknown): unknown {
  return {
    type: "custom_message",
    customType: MODE_MESSAGE_CUSTOM_TYPE,
    details,
  };
}

function triggerEntry(data?: unknown): unknown {
  return {
    type: "custom",
    customType: MODE_TRIGGER_CUSTOM_TYPE,
    data,
  };
}

test("replayLastReportedModeName returns null when the active branch has no mode message", () => {
  const ctx = createContext(() => []);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: null });
});

test("replayLastReportedModeName restores an explicit persisted no-mode state", () => {
  const ctx = createContext(() => [modeMessage({ modeName: null })]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: null });
});

test("replayLastReportedModeName preserves the no-mode marker through JSON serialization", () => {
  const persistedMessage = JSON.parse(JSON.stringify(modeMessage({ modeName: null })));
  const ctx = createContext(() => [persistedMessage]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: null });
});

test("replayLastReportedModeName restores a known mode name", () => {
  const ctx = createContext(() => [modeMessage({ modeName: "plan" })]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: "plan" });
});

test("replayLastReportedModeName uses the latest matching mode message", () => {
  const ctx = createContext(() => [
    modeMessage({ modeName: "plan" }),
    { type: "custom_message", customType: "another-extension", details: { modeName: "ignored" } },
    modeMessage({ modeName: "review" }),
  ]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: "review" });
});

test("replayLastReportedModeName skips non-custom-message entries", () => {
  const ctx = createContext(() => [
    { type: "message", message: { role: "custom", customType: "pi-tools-switch-mode" } },
    { type: "compaction", details: { modeName: "plan" } },
    modeMessage({ modeName: "plan" }),
  ]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: "plan" });
});

test("replayLastReportedModeName treats missing or malformed details as unknown", () => {
  for (const details of [
    undefined,
    "modeName",
    {},
    { modeName: undefined },
    { modeName: 42 },
    { modeName: false },
  ]) {
    const ctx = createContext(() => [modeMessage(details)]);
    assert.deepEqual(replayLastReportedModeName(ctx), { modeName: undefined });
  }
});

test("replayLastReportedModeName treats legacy mode messages without details as unknown", () => {
  const ctx = createContext(() => [modeMessage()]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: undefined });
});

test("replayLastReportedModeName returns an error when reading the active branch fails", () => {
  const ctx = createContext(() => {
    throw new Error("session unavailable");
  });

  assert.deepEqual(replayLastReportedModeName(ctx), {
    modeName: undefined,
    error: "session unavailable",
  });
});

// --- Persisted trigger-entry replay ----------------------------------------

test("replayLastTriggeredModeName returns null without a trigger entry", () => {
  const ctx = createContext(() => []);

  assert.deepEqual(replayLastTriggeredModeName(ctx), { modeName: null });
});

test("replayLastTriggeredModeName restores an enabled mode name", () => {
  const ctx = createContext(() => [triggerEntry({ modeName: "plan" })]);

  assert.deepEqual(replayLastTriggeredModeName(ctx), { modeName: "plan" });
});

test("replayLastTriggeredModeName restores an explicit persisted disabled state", () => {
  const persistedEntry = JSON.parse(JSON.stringify(triggerEntry({ modeName: null })));
  const ctx = createContext(() => [persistedEntry]);

  assert.deepEqual(replayLastTriggeredModeName(ctx), { modeName: null });
});

test("replayLastTriggeredModeName uses the latest matching trigger entry", () => {
  const ctx = createContext(() => [
    triggerEntry({ modeName: "plan" }),
    { type: "custom", customType: "another-extension", data: { modeName: "ignored" } },
    triggerEntry({ modeName: "review" }),
  ]);

  assert.deepEqual(replayLastTriggeredModeName(ctx), { modeName: "review" });
});

test("replayLastTriggeredModeName ignores non-custom entries", () => {
  const ctx = createContext(() => [
    modeMessage({ modeName: "plan" }),
    { type: "message", message: { role: "custom", customType: MODE_TRIGGER_CUSTOM_TYPE } },
    triggerEntry({ modeName: "plan" }),
  ]);

  assert.deepEqual(replayLastTriggeredModeName(ctx), { modeName: "plan" });
});

test("replayLastTriggeredModeName treats malformed trigger data as unknown", () => {
  for (const data of [
    undefined,
    "modeName",
    {},
    { modeName: undefined },
    { modeName: 42 },
    { modeName: false },
  ]) {
    const ctx = createContext(() => [triggerEntry(data)]);
    assert.deepEqual(replayLastTriggeredModeName(ctx), { modeName: undefined });
  }
});

test("replayLastTriggeredModeName leaves configured-mode validation to its caller", () => {
  const ctx = createContext(() => [triggerEntry({ modeName: "removed" })]);

  assert.deepEqual(replayLastTriggeredModeName(ctx), { modeName: "removed" });
});

test("replayLastTriggeredModeName returns an error when reading the active branch fails", () => {
  const ctx = createContext(() => {
    throw new Error("session unavailable");
  });

  assert.deepEqual(replayLastTriggeredModeName(ctx), {
    modeName: undefined,
    error: "session unavailable",
  });
});

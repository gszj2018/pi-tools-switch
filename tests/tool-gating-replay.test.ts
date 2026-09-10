/**
 * Unit tests for persisted mode payload parsing and active-branch replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MODE_MESSAGE_CUSTOM_TYPE,
  MODE_TRIGGER_CUSTOM_TYPE,
  replayLastReportedModeName,
  replayLastTriggeredModeName,
  replayModeName,
  type ReplayResult,
} from "../extension/tool-gating-replay.ts";

function createContext(getBranch: () => unknown[]): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => getBranch() as never,
    },
  } as unknown as ExtensionContext;
}

function modeMessage(details?: unknown) {
  return {
    type: "custom_message",
    customType: MODE_MESSAGE_CUSTOM_TYPE,
    details,
  };
}

function triggerEntry(data?: unknown) {
  return {
    type: "custom",
    customType: MODE_TRIGGER_CUSTOM_TYPE,
    data,
  };
}

type Replay = typeof replayLastReportedModeName;
type EntryFactory = typeof modeMessage | typeof triggerEntry;

function assertReplay(replay: Replay, branch: unknown[], expected: ReplayResult): void {
  assert.deepEqual(replay(createContext(() => branch)), expected);
}

function assertSerializedNoMode(replay: Replay, entry: EntryFactory): void {
  const persisted = JSON.parse(JSON.stringify(entry({ modeName: null })));
  assertReplay(replay, [persisted], { modeName: null });
}

function assertLatestMode(replay: Replay, entry: EntryFactory): void {
  assertReplay(replay, [
    entry({ modeName: "plan" }),
    entry({ modeName: "review" }),
    { ...entry({ modeName: "ignored" }), customType: "another-extension" },
  ], { modeName: "review" });
}

function assertIgnoredEntryTypes(replay: Replay, entry: EntryFactory, otherEntryType: string): void {
  assertReplay(replay, [
    entry({ modeName: "plan" }),
    { ...entry({ modeName: "ignored" }), type: otherEntryType },
    { type: "message", message: { role: "custom", customType: entry().customType } },
    { type: "compaction", details: { modeName: "ignored" } },
  ], { modeName: "plan" });
}

function assertMalformedPayloads(replay: Replay, entry: EntryFactory): void {
  for (const payload of [
    undefined,
    "modeName",
    {},
    { modeName: undefined },
    { modeName: 42 },
    { modeName: false },
  ]) {
    assertReplay(replay, [entry(payload)], { modeName: undefined });
  }
}

function assertReadFailure(replay: Replay): void {
  const ctx = createContext(() => {
    throw new Error("session unavailable");
  });
  assert.deepEqual(replay(ctx), { modeName: undefined, error: "session unavailable" });
}

test("replayModeName preserves strings and null without validating configured names", () => {
  for (const modeName of ["plan", "removed", "", null]) {
    const data = Object.freeze({ modeName });
    assert.deepEqual(replayModeName(data), { modeName });
  }
});

test("replayModeName returns unknown for missing or malformed payloads", () => {
  for (const data of [
    undefined,
    null,
    "modeName",
    42,
    false,
    [],
    {},
    { modeName: undefined },
    { modeName: 42 },
    { modeName: false },
    { modeName: [] },
    { modeName: {} },
  ]) {
    assert.deepEqual(replayModeName(data), { modeName: undefined });
  }
});

test("replayLastReportedModeName returns null when the active branch has no mode message", () => {
  assertReplay(replayLastReportedModeName, [], { modeName: null });
});

test("replayLastReportedModeName restores an explicit persisted no-mode state", () => {
  assertReplay(replayLastReportedModeName, [modeMessage({ modeName: null })], { modeName: null });
});

test("replayLastReportedModeName preserves the no-mode marker through JSON serialization", () => {
  assertSerializedNoMode(replayLastReportedModeName, modeMessage);
});

test("replayLastReportedModeName restores a known mode name", () => {
  assertReplay(replayLastReportedModeName, [modeMessage({ modeName: "plan" })], { modeName: "plan" });
});

test("replayLastReportedModeName uses the latest matching mode message", () => {
  assertLatestMode(replayLastReportedModeName, modeMessage);
});

test("replayLastReportedModeName skips non-custom-message entries", () => {
  assertIgnoredEntryTypes(replayLastReportedModeName, modeMessage, "custom");
});

test("replayLastReportedModeName treats missing or malformed details as unknown", () => {
  assertMalformedPayloads(replayLastReportedModeName, modeMessage);
});

test("replayLastReportedModeName treats legacy mode messages without details as unknown", () => {
  const entry = { type: "custom_message", customType: MODE_MESSAGE_CUSTOM_TYPE };
  assertReplay(replayLastReportedModeName, [entry], { modeName: undefined });
});

test("replayLastReportedModeName returns an error when reading the active branch fails", () => {
  assertReadFailure(replayLastReportedModeName);
});

// --- Persisted trigger-entry replay ----------------------------------------

test("replayLastTriggeredModeName returns null without a trigger entry", () => {
  assertReplay(replayLastTriggeredModeName, [], { modeName: null });
});

test("replayLastTriggeredModeName restores an enabled mode name", () => {
  assertReplay(replayLastTriggeredModeName, [triggerEntry({ modeName: "plan" })], { modeName: "plan" });
});

test("replayLastTriggeredModeName restores an explicit persisted disabled state", () => {
  assertSerializedNoMode(replayLastTriggeredModeName, triggerEntry);
});

test("replayLastTriggeredModeName uses the latest matching trigger entry", () => {
  assertLatestMode(replayLastTriggeredModeName, triggerEntry);
});

test("replayLastTriggeredModeName ignores non-custom entries", () => {
  assertIgnoredEntryTypes(replayLastTriggeredModeName, triggerEntry, "custom_message");
});

test("replayLastTriggeredModeName treats malformed trigger data as unknown", () => {
  assertMalformedPayloads(replayLastTriggeredModeName, triggerEntry);
});

test("replayLastTriggeredModeName leaves configured-mode validation to its caller", () => {
  assertReplay(replayLastTriggeredModeName, [triggerEntry({ modeName: "removed" })], { modeName: "removed" });
});

test("replayLastTriggeredModeName returns an error when reading the active branch fails", () => {
  assertReadFailure(replayLastTriggeredModeName);
});

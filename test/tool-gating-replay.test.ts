/**
 * Unit tests for replaying the last injected tool-gating mode message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { replayLastReportedModeName } from "../extension/tool-gating-replay.ts";

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
    customType: "pi-tools-switch-mode",
    details,
  };
}

test("replayLastReportedModeName returns undefined when the active branch has no mode message", () => {
  const ctx = createContext(() => []);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: undefined });
});

test("replayLastReportedModeName restores an explicit no-mode state", () => {
  const ctx = createContext(() => [modeMessage({ modeName: undefined })]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: undefined });
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
  for (const details of [undefined, null, "modeName", {}, { modeName: 42 }, { modeName: false }]) {
    const ctx = createContext(() => [modeMessage(details)]);
    assert.deepEqual(replayLastReportedModeName(ctx), { modeName: null });
  }
});

test("replayLastReportedModeName treats legacy mode messages without details as unknown", () => {
  const ctx = createContext(() => [modeMessage()]);

  assert.deepEqual(replayLastReportedModeName(ctx), { modeName: null });
});

test("replayLastReportedModeName returns an error when reading the active branch fails", () => {
  const ctx = createContext(() => {
    throw new Error("session unavailable");
  });

  assert.deepEqual(replayLastReportedModeName(ctx), {
    modeName: null,
    error: "session unavailable",
  });
});

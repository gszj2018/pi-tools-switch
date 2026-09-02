import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Custom message type used to persist LLM-visible gating state reports. */
export const MODE_MESSAGE_CUSTOM_TYPE = "pi-tools-switch-mode";

/** Custom entry type used to persist real gating-mode transitions. */
export const MODE_TRIGGER_CUSTOM_TYPE = "pi-tools-switch-trigger";

export interface ReplayResult {
  /**
   * string: a known gating mode; null: no gating mode; undefined: the stored
   * state could not be recognized and the caller must force a new message.
   */
  modeName: string | null | undefined;
  /** The replay failure message, when reading the active branch throws. */
  error?: string;
}

/**
 * Scan the active branch for the latest entry matching `entryType` +
 * `customType`, and extract the persisted mode name from the entry's payload
 * field. The message entry (`custom_message`) carries the payload in
 * `details`, while the trigger entry (`custom`) carries it in `data`; the
 * field is derived from `entryType` because the mapping is fixed by the Pi
 * session-entry types.
 */
function replayLastModeName(
  ctx: ExtensionContext,
  entryType: "custom" | "custom_message",
  customType: string,
): ReplayResult {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== entryType || entry.customType !== customType) continue;
      // custom_message -> details, custom -> data.
      return replayModeName(entry.type === "custom_message" ? entry.details : entry.data);
    }
    return replayNoModeName();
  } catch (error) {
    return replayInvalidModeName(error);
  }
}

/**
 * Restore the mode name reported by the latest gating-state message on the
 * active branch. Entries without a matching custom type are ignored.
 */
export function replayLastReportedModeName(ctx: ExtensionContext): ReplayResult {
  return replayLastModeName(ctx, "custom_message", MODE_MESSAGE_CUSTOM_TYPE);
}

/**
 * Restore the target mode from the latest persisted mode-trigger entry on the
 * active branch. This helper validates only the persisted data shape; the
 * lifecycle integration validates a restored string against current modes.
 */
export function replayLastTriggeredModeName(ctx: ExtensionContext): ReplayResult {
  return replayLastModeName(ctx, "custom", MODE_TRIGGER_CUSTOM_TYPE);
}

function replayModeName(data: unknown): ReplayResult {
  if (data === null || typeof data !== "object" || !("modeName" in data)) {
    return replayInvalidModeName();
  }

  const { modeName } = data;
  if (typeof modeName === "string") return { modeName };
  // null is the JSON-safe persisted representation of no active mode.
  if (modeName === null) return replayNoModeName();
  return replayInvalidModeName();
}

function replayNoModeName(): ReplayResult {
  return { modeName: null };
}

function replayInvalidModeName(error?: unknown): ReplayResult {
  if (error === undefined) return { modeName: undefined };
  return {
    modeName: undefined,
    error: error instanceof Error ? error.message : String(error),
  };
}

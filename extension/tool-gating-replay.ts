import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODE_MESSAGE_CUSTOM_TYPE = "pi-tools-switch-mode";

/** Custom entry type used to persist real gating-mode transitions. */
export const MODE_TRIGGER_CUSTOM_TYPE = "pi-tools-switch-trigger";

export interface ReplayResult {
  /**
   * string: a known gating mode; undefined: no gating mode; null: the stored
   * state could not be recognized and the caller must force a new message.
   */
  modeName: string | undefined | null;
  /** The replay failure message, when reading the active branch throws. */
  error?: string;
}

/**
 * Restore the mode name reported by the latest gating-state message on the
 * active branch. Entries without a matching custom type are ignored.
 */
export function replayLastReportedModeName(ctx: ExtensionContext): ReplayResult {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "custom_message" || entry.customType !== MODE_MESSAGE_CUSTOM_TYPE) {
        continue;
      }

      return replayModeName(entry.details);
    }
    return { modeName: undefined };
  } catch (error) {
    return replayError(error);
  }
}

/**
 * Restore the target mode from the latest persisted mode-trigger entry on the
 * active branch. This helper validates only the persisted data shape; the
 * lifecycle integration validates a restored string against current modes.
 */
export function replayLastTriggeredModeName(ctx: ExtensionContext): ReplayResult {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== MODE_TRIGGER_CUSTOM_TYPE) {
        continue;
      }

      return replayModeName(entry.data);
    }
    return { modeName: undefined };
  } catch (error) {
    return replayError(error);
  }
}

function replayModeName(data: unknown): ReplayResult {
  if (data === null || typeof data !== "object" || !("modeName" in data)) {
    return { modeName: null };
  }

  const { modeName } = data;
  if (typeof modeName === "string") return { modeName };
  // null is the JSON-safe persisted representation of no active mode.
  if (modeName === null) return { modeName: undefined };
  return { modeName: null };
}

function replayError(error: unknown): ReplayResult {
  return {
    modeName: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

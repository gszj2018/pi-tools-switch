import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODE_MESSAGE_CUSTOM_TYPE = "pi-tools-switch-mode";

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

      const details = entry.details;
      if (details === null || typeof details !== "object" || !("modeName" in details)) {
        return { modeName: null };
      }

      const { modeName } = details;
      if (typeof modeName === "string" || modeName === undefined) {
        return { modeName };
      }
      return { modeName: null };
    }
    return { modeName: undefined };
  } catch (error) {
    return {
      modeName: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

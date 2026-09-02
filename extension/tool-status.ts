/**
 * Read-only tool and gating status command.
 *
 * This module receives immutable status readers from the tool-management and
 * tool-gating modules. It never modifies active tools, gating state, config,
 * or session entries.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ToolStatusReader,
  type ToolStatusSnapshot,
} from "./builtin-tools.ts";
import {
  EXIT_MODE_TOOL_NAME,
  type GatingStatusReader,
  type GatingStatusSnapshot,
} from "./tool-gating.ts";
import { READ_ONLY_TOOLS } from "./utils.ts";
import { rejectUnexpectedArgs } from "./utils-pi.ts";

export type GatingStatusMarker = "[ ]" | "[-]" | "[*]";

/**
 * Return the marker that describes how an active gate treats a tool call.
 * Write/edit receive [*] only when their paths are conditionally permitted by
 * a non-empty allowWriteDir and they are not explicitly allowed outright.
 */
export function getGatingStatusMarker(
  toolName: string,
  gatingStatus: GatingStatusSnapshot,
): GatingStatusMarker {
  if (gatingStatus.activeModeName === null) return "[ ]";
  if (
    toolName === EXIT_MODE_TOOL_NAME ||
    READ_ONLY_TOOLS.includes(toolName) ||
    gatingStatus.allowTools.includes(toolName)
  ) {
    return "[ ]";
  }
  if (
    (toolName === "write" || toolName === "edit") &&
    gatingStatus.allowWriteDir.length > 0
  ) {
    return "[*]";
  }
  return "[-]";
}

/** Format the complete status listing in the supplied Pi tool order. */
export function formatToolStatus(
  toolStatus: readonly ToolStatusSnapshot[],
  gatingStatus: GatingStatusSnapshot,
): string {
  return toolStatus
    .map((tool) => {
      const enabled = tool.enabled ? "[+]" : "[ ]";
      const marker = getGatingStatusMarker(tool.name, gatingStatus);
      const kind = tool.builtIn ? " (built-in)" : "";
      return `${enabled}${marker} ${tool.name}${kind}`;
    })
    .join("\n");
}

/** Register the read-only /ptsw-status command. */
export function register(
  pi: ExtensionAPI,
  readToolStatus: ToolStatusReader,
  readGatingStatus: GatingStatusReader,
): void {
  pi.registerCommand("ptsw-status", {
    description: "Show all tool and gating status",
    handler: async (args, ctx) => {
      if (rejectUnexpectedArgs(args, "/ptsw-status", ctx)) return;
      ctx.ui.notify(formatToolStatus(readToolStatus(), readGatingStatus()), "info");
    },
  });
}

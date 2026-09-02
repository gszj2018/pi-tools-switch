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
import type { GatingStatusReader, GatingToolStatus } from "./tool-gating.ts";
import { rejectUnexpectedArgs } from "./utils-pi.ts";

export type GatingStatusMarker = "[ ]" | "[-]" | "[*]";

/**
 * Return the marker that describes a tool's derived gating status. A [*]
 * marker is used only for tools that are path-restricted write/edit calls.
 */
export function getGatingStatusMarker(gatingStatus: GatingToolStatus): GatingStatusMarker {
  if (gatingStatus.unrestricted) return "[ ]";
  return gatingStatus.hasAllowedWriteDir ? "[*]" : "[-]";
}

/** Format the complete status listing in the supplied Pi tool order. */
export function formatToolStatus(
  toolStatus: readonly ToolStatusSnapshot[],
  readGatingStatus: GatingStatusReader,
): string {
  return toolStatus
    .map((tool) => {
      const enabled = tool.enabled ? "[+]" : "[ ]";
      const marker = getGatingStatusMarker(readGatingStatus(tool.name));
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
      ctx.ui.notify(formatToolStatus(readToolStatus(), readGatingStatus), "info");
    },
  });
}

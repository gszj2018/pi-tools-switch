/**
 * Utilities coupled to the Pi Extension API.
 *
 * Keep these separate from utils.ts, whose helpers have no Pi API dependency.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Reject arguments passed to an argument-free extension command. */
export function rejectUnexpectedArgs(
  args: string,
  usage: string,
  ctx: ExtensionCommandContext,
): boolean {
  if (args.trim() === "") return false;
  ctx.ui.notify(`Unexpected arguments. Usage: ${usage}`, "error");
  return true;
}

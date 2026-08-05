/**
 * Tool guide system prompt injection for pi-tools-switch.
 *
 * Caches toolGuide.enabled at session start into module-local state and owns
 * the "pi-tools-switch-guide" status bar ([+G] enabled / [-G] disabled).
 * before_agent_start reads the cached value instead of the config.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

const GUIDE_STATUS_BAR_KEY = "pi-tools-switch-guide";

const TOOL_GUIDE_PROMPT = `When exploring or searching the project, prefer the find, grep, or ls tools over bash whenever they are available.`;

/** Status bar text for the tool guide: [+G] enabled, [-G] disabled. */
export function formatGuideStatus(enabled: boolean): string {
  return enabled ? "[+G]" : "[-G]";
}

export function register(pi: ExtensionAPI, getConfig: () => Config): void {
  // Cached from config at session start; matches the default until then.
  let toolGuideEnabled = true;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    toolGuideEnabled = getConfig().toolGuide.enabled;
    ctx.ui.setStatus(GUIDE_STATUS_BAR_KEY, formatGuideStatus(toolGuideEnabled));
  });

  pi.on("before_agent_start", async (event) => {
    if (!toolGuideEnabled) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + TOOL_GUIDE_PROMPT };
  });
}

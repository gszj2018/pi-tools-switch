/**
 * Tool guide system prompt injection for pi-tools-switch.
 *
 * Stateless module: injects exploration guidance into the system prompt on
 * every agent start when the tool guide is enabled (default). Injection does
 * not depend on whether find/grep/ls are currently available.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

const TOOL_GUIDE_PROMPT = `When exploring or searching the project, prefer the find, grep, or ls tools over bash whenever they are available.`;

export function register(pi: ExtensionAPI, getConfig: () => Config): void {
  pi.on("before_agent_start", async (event) => {
    if (!getConfig().toolGuide.enabled) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + TOOL_GUIDE_PROMPT };
  });
}

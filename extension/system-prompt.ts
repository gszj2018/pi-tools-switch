/**
 * System prompt injection for pi-tools-switch.
 *
 * Always appends the tool-guide prompt and the tool-gating guidance prompt at
 * before_agent_start (no config switch), and owns the "pi-tools-switch-spl"
 * status bar showing the system prompt length ([SPL: -] at session start,
 * [SPL: <length>] at agent_start). No config dependency.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPL_STATUS_BAR_KEY = "pi-tools-switch-spl";

/** Tool guidance: prefer the dedicated search tools over bash. */
export const TOOL_GUIDE_PROMPT = `When exploring or searching the project, prefer the find, grep, or ls tools over bash whenever they are available.`;

/**
 * Gating-mode guidance: helps the model understand tool gating modes and how
 * to interact with the per-mode finish tool (finish_<name>_mode).
 */
export const GATING_MODE_GUIDANCE_PROMPT = `This coding assistant has several tool gating modes; while a specific mode is active, some tool calls are restricted.

- Restricted tools still appear in the available tools list, but calls that do not comply with the active mode are intercepted by the system, which returns an error explaining the restriction.
- A gating mode is enabled by a matching prompt, such as a skill invocation or a specific input prefix.
- While a gating mode is active, a finish tool named \`finish_<name>_mode\` becomes available.
- When you have completed the task and are ready to leave the gating mode, call that finish tool to ask the user. The user may then choose to exit the mode and end the current turn, or ask you to continue refining the work; in the latter case the conversation continues and the gating mode stays active.
- The gating mode ends when the current conversation terminates, whether or not you called the finish tool. Re-entering a mode later always requires the user to enable it explicitly, and there may be no special prompt when it turns off.
- The only reliable way to tell whether a gating mode is currently active is to check whether a \`finish_<name>_mode\` tool is available right now. Do not trust other sources of information (for example, your memory), which may reflect stale state.`;

/** Status bar text for the system prompt length: [SPL: <length>] or [SPL: -]. */
export function formatSplStatus(length: number | undefined): string {
  return `[SPL: ${length ?? "-"}]`;
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus(SPL_STATUS_BAR_KEY, formatSplStatus(undefined));
  });

  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus(SPL_STATUS_BAR_KEY, formatSplStatus(ctx.getSystemPrompt().length));
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${TOOL_GUIDE_PROMPT}\n\n${GATING_MODE_GUIDANCE_PROMPT}`,
    };
  });
}

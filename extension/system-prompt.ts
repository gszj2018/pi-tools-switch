/**
 * System prompt injection for pi-tools-switch.
 *
 * The main registration (register) always appends the tool-guide prompt and
 * the tool-gating guidance prompt at before_agent_start (no config switch),
 * and owns the "pi-tools-switch-spl" status bar showing the system prompt
 * length ([SPL: -] at session start, [SPL: <length>] at agent_start). The
 * subagent registration (registerForSubagent) injects only the tool-guide
 * prompt and owns no status bar. No config dependency.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPL_STATUS_BAR_KEY = "pi-tools-switch-spl";

/** Tool guidance: prefer the dedicated search tools over bash. */
export const TOOL_GUIDE_PROMPT = `When exploring or searching the project, prefer the find, grep, or ls tools over bash whenever they are available.`;

/**
 * Gating-mode guidance: helps the model understand tool gating modes and how
 * to interact with the per-mode finish tool (finish_<name>_mode). The current
 * mode is always reported by an injected message, never inferred from tool
 * availability.
 */
export const GATING_MODE_GUIDANCE_PROMPT = `This coding assistant has several tool gating modes; while a specific mode is active, some tool calls are restricted.

- Restricted tools still appear in the available tools list, but calls that do not comply with the active mode are intercepted by the system, which returns an error explaining the restriction.
- A gating mode is enabled by a matching prompt, such as a skill invocation or a specific input prefix.
- The system injects a message whenever your gating state changes: it states which mode you are in and its restrictions, or that you are not currently in any gating mode. Treat that message as the authoritative source for the current gating state; do not infer it from tool availability or from your memory of earlier turns, which may be stale.
- While a gating mode is active, a finish tool named \`finish_<name>_mode\` becomes available, but its availability is not a reliable indicator of the current mode.
- When you have completed the task and are ready to leave the gating mode, call that finish tool to ask the user. The user may then choose to exit the mode and end the current turn, or ask you to continue refining the work; in the latter case the conversation continues and the gating mode stays active.
- The gating mode ends when the current conversation terminates, whether or not you called the finish tool, and the system then injects a message telling you that you are no longer in a gating mode. Re-entering a mode later always requires the user to enable it explicitly.`;

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

/**
 * Subagent variant of register: injects only the tool-guide prompt and no
 * gating-mode guidance, and owns no SPL status bar. Used by index.ts when the
 * extension runs inside a subagent, where built-in tools management and tool
 * gating are skipped entirely.
 */
export function registerForSubagent(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${TOOL_GUIDE_PROMPT}` };
  });
}

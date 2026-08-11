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
- A gating mode is enabled by a matching prompt, such as a skill invocation or a specific input prefix, and stays active until the user exits it explicitly.
- The system injects an authoritative message reporting the current gating state.
- When the work is complete, call the finish tool \`finish_<name>_mode\` to ask the user: they may accept and exit the mode (ending the turn), accept and stay in the mode (ending the turn), or request further improvements (the turn continues and the mode stays active).`;

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

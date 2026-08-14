/**
 * Tool gating for pi-tools-switch: prefix-triggered modes that restrict tool
 * usage. A mode is activated by an input prefix and stays active across turns
 * until it is explicitly exited (the gating exit trigger, another mode's
 * trigger, or the finish tool's "accept and exit" choice).
 *
 * Module-local state only: owns the active mode name and the
 * "pi-tools-switch-mode" status bar. No shared mutable state.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_ONLY_TOOLS, isPathInDirs, resolveDir } from "./utils.ts";
import { rejectUnexpectedArgs } from "./utils-pi.ts";
import type { Config, GatingModeConfig } from "./config.ts";

const MODE_STATUS_BAR_KEY = "pi-tools-switch-mode";

export const EXIT_MODE_TOOL_NAME = "exit_mode";

export const EXIT_MODE_PROMPT_SNIPPET =
  "Submit a concise one-sentence summary for the active gating mode and ask whether to exit, stay, or refine";

export const EXIT_MODE_PROMPT_GUIDELINES = [
  "exit_mode is the completion tool for tool-gating modes. Restricted tools may remain visible, but calls that violate the active mode are intercepted with an explanatory error.",
  "A gating mode is activated by a matching prompt and remains active until explicitly exited; treat the injected gating-state message as authoritative, and pass its exact mode name to exit_mode.",
  "Before calling exit_mode, output any full deliverable separately. Then call exit_mode with the current mode and a concise one-sentence summary; the user may accept and exit, accept and stay, or request further improvements.",
];

/** Built-in gating modes, keyed by mode name. User modes with the same name override them. */
export const BUILTIN_GATING_MODES: Record<string, GatingModeConfig> = {
  plan: {
    trigger: ["/skill:plan-mode"],
    allowTools: [],
    allowWriteDir: [".agents/plans"],
  },
};

/** Merge built-in gating modes with user modes (user wins on name collision). */
export function mergeGatingModes(
  userModes: Record<string, GatingModeConfig>,
): Record<string, GatingModeConfig> {
  return { ...BUILTIN_GATING_MODES, ...userModes };
}

/** Return true when any non-empty trigger is a prefix of `text`. */
export function matchAnyTrigger(text: string, triggers: readonly string[]): boolean {
  return triggers.some((trigger) => trigger.length > 0 && text.startsWith(trigger));
}

/** Return the first mode whose trigger is a prefix of `text`, if any. */
export function matchTrigger(
  text: string,
  modes: Record<string, GatingModeConfig>,
): string | undefined {
  for (const [name, mode] of Object.entries(modes)) {
    if (matchAnyTrigger(text, mode.trigger)) return name;
  }
  return undefined;
}

/** Status bar text: [M: <name>] or [M: -]. */
export function formatModeStatus(name: string | undefined): string {
  return `[M: ${name ?? "-"}]`;
}

/** Blocked reason for write/edit when the target is outside allowWriteDir. */
function buildWriteReason(modeName: string, mode: GatingModeConfig, cwd: string): string {
  let reason = `In ${modeName} mode, file modification is not allowed`;
  if (mode.allowWriteDir.length > 0) {
    const dirs = mode.allowWriteDir.map((dir) => resolveDir(dir, cwd)).join(", ");
    reason += `\nExcept in the following directories: ${dirs}`;
  }
  return reason;
}

/**
 * Blocked reason for other tools: lists the allowed tools (finish, read-only,
 * and mode allowTools) and notes that write/edit are conditionally allowed.
 */
export function buildBlockReason(modeName: string, mode: GatingModeConfig): string {
  const allowed = [
    ...new Set([`finish_${modeName}_mode`, ...READ_ONLY_TOOLS, ...mode.allowTools]),
  ];
  let reason = `In ${modeName} mode, this tool is not allowed. Allowed tools: ${allowed.join(", ")}`;
  reason +=
    mode.allowWriteDir.length > 0
      ? ". write/edit are conditionally allowed"
      : ". write/edit are not allowed";
  return reason;
}

/**
 * Mode-state message text injected before an agent turn: states the active
 * mode and its restrictions, or that no gating mode is active.
 */
export function buildModeMessage(
  modeName: string | undefined,
  mode: GatingModeConfig | undefined,
  cwd: string,
): string {
  if (!modeName || !mode) {
    return `You are not currently in any gating mode. You may call any available tool.`;
  }
  const allowed = [
    ...new Set([`finish_${modeName}_mode`, ...READ_ONLY_TOOLS, ...mode.allowTools]),
  ];
  let text = `You are in ${modeName} mode. Allowed tools: ${allowed.join(", ")}`;
  if (mode.allowWriteDir.length > 0) {
    // Backticks render the path as an inline code span, which preserves the
    // backslashes (plain text would treat `\.` as a CommonMark escape).
    const dirs = mode.allowWriteDir.map((dir) => `\`${resolveDir(dir, cwd)}\``).join(", ");
    text += `. write/edit are allowed only in: ${dirs}`;
  } else {
    text += `. write/edit are not allowed`;
  }
  text += `. Other tools are blocked.`;
  return text;
}

/**
 * Whether a mode-state message should be injected for the current turn:
 * always on the first turn after session start (no reported mode yet), and
 * whenever the active mode differs from the mode reported by the previous
 * injected message.
 */
export function shouldInjectModeMessage(
  lastReportedModeName: string | undefined | null,
  activeModeName: string | undefined,
): boolean {
  return lastReportedModeName === null || activeModeName !== lastReportedModeName;
}

interface GatingDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a tool call is allowed under the active gating mode.
 * Check order: inactive -> finish tool -> read-only -> allowTools ->
 * write/edit with allowWriteDir -> block everything else.
 */
export function decideToolCall(
  toolName: string,
  input: unknown,
  modeName: string | undefined,
  mode: GatingModeConfig | undefined,
  finishToolNames: readonly string[],
  cwd: string,
): GatingDecision {
  if (!mode || !modeName) return { allowed: true };
  if (finishToolNames.includes(toolName)) return { allowed: true };
  if (READ_ONLY_TOOLS.includes(toolName)) return { allowed: true };
  if (mode.allowTools.includes(toolName)) return { allowed: true };
  if (toolName === "write" || toolName === "edit") {
    const path = (input as { path?: unknown } | undefined)?.path;
    if (typeof path === "string" && isPathInDirs(path, mode.allowWriteDir, cwd)) {
      return { allowed: true };
    }
    return { allowed: false, reason: buildWriteReason(modeName, mode, cwd) };
  }
  return { allowed: false, reason: buildBlockReason(modeName, mode) };
}

export function register(pi: ExtensionAPI, getConfig: () => Config): void {
  // Merged gating modes cached once at load time (rebuilt on extension reload).
  const modes = mergeGatingModes(getConfig().gatingModes);
  // Exit-trigger prefixes cached once at load time (rebuilt on extension reload).
  const exitTriggers = getConfig().gatingExitTrigger;
  // Finish tool names derive from the cached modes and never change at runtime
  // (rebuilt on extension reload), so they are cached here too.
  const finishToolNames = Object.keys(modes).map((name) => `finish_${name}_mode`);
  const finishToolNameSet = new Set(finishToolNames);

  let activeModeName: string | undefined;
  let activeMode: GatingModeConfig | undefined;
  // Mode reported by the last injected mode-state message; null = no message
  // has been injected yet (first turn after session start).
  let lastReportedModeName: string | undefined | null = null;
  // Guard flag: raised once the mode is confirmed at before_agent_start and
  // cleared at agent_settled. While raised, input events (e.g. steering
  // input) must not change the mode.
  let modeGuardActive = false;

  const refreshStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(MODE_STATUS_BAR_KEY, formatModeStatus(activeModeName));
  };

  const removeFinishTools = (): void => {
    pi.setActiveTools(pi.getActiveTools().filter((tool) => !finishToolNameSet.has(tool)));
  };

  const setMode = (name: string | undefined, ctx: ExtensionContext): void => {
    if (name === undefined) {
      activeModeName = undefined;
      activeMode = undefined;
      removeFinishTools();
    } else {
      const mode = modes[name];
      if (!mode) return;
      // Switching modes: only the active mode's finish tool may be present, so
      // drop every finish tool first, then add the new mode's own.
      pi.setActiveTools([
        ...pi.getActiveTools().filter((tool) => !finishToolNameSet.has(tool)),
        `finish_${name}_mode`,
      ]);
      activeModeName = name;
      activeMode = mode;
    }
    refreshStatus(ctx);
  };

  const ensureExitModeActive = (): void => {
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes(EXIT_MODE_TOOL_NAME)) {
      pi.setActiveTools([...activeTools, EXIT_MODE_TOOL_NAME]);
    }
  };

  const registerExitModeTool = (): void => {
    pi.registerTool({
      name: EXIT_MODE_TOOL_NAME,
      label: "Complete Current Gating Mode",
      description:
        "Submit a concise one-sentence completion summary for the active tool gating mode and ask the user whether to exit, stay, or refine. Output any full deliverable separately before calling this tool.",
      promptSnippet: EXIT_MODE_PROMPT_SNIPPET,
      promptGuidelines: EXIT_MODE_PROMPT_GUIDELINES,
      executionMode: "sequential",
      parameters: Type.Object({
        mode: Type.String({
          description: "Exact active mode name from the injected gating-state message.",
        }),
        summary: Type.String({
          description:
            "Concise one-sentence summary of the completed work. Output any full deliverable separately before calling exit_mode; do not include it in summary.",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const modeName = activeModeName;
        if (!modeName || !activeMode) {
          throw new Error("exit_mode failed: no gating mode is currently active.");
        }
        if (params.mode !== modeName) {
          throw new Error(
            `exit_mode failed: requested mode "${params.mode}" does not match the active mode "${modeName}".`,
          );
        }

        const acceptAndExit = (): {
          content: { type: "text"; text: string }[];
          details: Record<string, unknown>;
          terminate: true;
        } => {
          ctx.ui.notify(params.summary, "info");
          setMode(undefined, ctx);
          return {
            content: [
              { type: "text", text: `The user has accepted. Exiting ${modeName} mode now.` },
            ],
            details: { summary: params.summary },
            terminate: true,
          };
        };
        const acceptAndStay = (): {
          content: { type: "text"; text: string }[];
          details: Record<string, unknown>;
          terminate: true;
        } => {
          ctx.ui.notify(params.summary, "info");
          return {
            content: [
              { type: "text", text: `The user has accepted. You are still in ${modeName} mode.` },
            ],
            details: { summary: params.summary },
            terminate: true,
          };
        };
        if (!ctx.hasUI) return acceptAndExit();
        const choice = await ctx.ui.select(
          `${modeName} mode: accept and exit, accept and stay, or refine?\n${params.summary}`,
          ["Accept and exit mode", "Accept and stay in mode", "Refine"],
        );
        if (choice === "Accept and stay in mode") return acceptAndStay();
        if (choice === "Refine") {
          const refinement = (await ctx.ui.input("Refinement:", ""))?.trim() ?? "";
          const hint = refinement ? ` Refinement hint: ${refinement}` : "";
          return {
            content: [
              {
                type: "text",
                text: `The user requested further improvements. You are still in ${modeName} mode.${hint}`,
              },
            ],
            details: { summary: params.summary },
          };
        }
        return acceptAndExit();
      },
    });
    ensureExitModeActive();
  };

  const registerFinishTool = (modeName: string): void => {
    const toolName = `finish_${modeName}_mode`;
    pi.registerTool({
      name: toolName,
      label: `Finish ${modeName} mode`,
      description: `Finish ${modeName} mode: submit the final summary.`,
      parameters: Type.Object({
        summary: Type.String({ description: "Summary of the completed mode work." }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const acceptAndExit = (): {
          content: { type: "text"; text: string }[];
          details: Record<string, unknown>;
          terminate: true;
        } => {
          ctx.ui.notify(params.summary, "info");
          // Accept-and-exit turns the gate off as part of this choice.
          setMode(undefined, ctx);
          return {
            content: [
              { type: "text", text: `The user has accepted. Exiting ${modeName} mode now.` },
            ],
            details: { summary: params.summary },
            terminate: true,
          };
        };
        const acceptAndStay = (): {
          content: { type: "text"; text: string }[];
          details: Record<string, unknown>;
          terminate: true;
        } => {
          ctx.ui.notify(params.summary, "info");
          return {
            content: [
              { type: "text", text: `The user has accepted. You are still in ${modeName} mode.` },
            ],
            details: { summary: params.summary },
            terminate: true,
          };
        };
        if (!ctx.hasUI) return acceptAndExit();
        const choice = await ctx.ui.select(
          `${modeName} mode: accept and exit, accept and stay, or refine?\n${params.summary}`,
          ["Accept and exit mode", "Accept and stay in mode", "Refine"],
        );
        if (choice === "Accept and stay in mode") return acceptAndStay();
        if (choice === "Refine") {
          const refinement = (await ctx.ui.input("Refinement:", ""))?.trim() ?? "";
          const hint = refinement ? ` Refinement hint: ${refinement}` : "";
          return {
            content: [
              {
                type: "text",
                text: `The user requested further improvements. You are still in ${modeName} mode.${hint}`,
              },
            ],
            details: { summary: params.summary },
          };
        }
        return acceptAndExit();
      },
    });
  };

  // Register the stable completion tool at extension load time and keep the
  // legacy per-mode tools until the dynamic-tool removal step is applied.
  registerExitModeTool();
  for (const name of Object.keys(modes)) {
    registerFinishTool(name);
  }

  pi.on("session_start", async (_event, ctx) => {
    // New session: no reported mode yet and the guard is down; reset through
    // the single state-change entry point.
    modeGuardActive = false;
    lastReportedModeName = null;
    setMode(undefined, ctx);
    ensureExitModeActive();
  });

  pi.on("input", async (event, ctx) => {
    const modeMatch = matchTrigger(event.text, modes);
    const exitMatch = matchAnyTrigger(event.text, exitTriggers);
    // While the guard is raised (an agent run is in progress), input that
    // attempts a switch (a mode trigger or the exit trigger) is consumed so it
    // never reaches the agent, with an error notice. Ordinary input (normal
    // steering/follow-up) passes through untouched.
    if (modeGuardActive) {
      if (modeMatch || exitMatch) {
        ctx.ui.notify(
          "Cannot switch the gating mode while the agent is running. Wait for the current turn to finish.",
          "error",
        );
        return { action: "handled" };
      }
      return;
    }
    // A mode trigger activates/switches the mode; otherwise any exit-trigger
    // match exits the active mode (harmless when none is active).
    if (modeMatch) {
      setMode(modeMatch, ctx);
      return;
    }
    if (exitMatch) {
      setMode(undefined, ctx);
      return;
    }
    refreshStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activeMode || !activeModeName) return;
    const decision = decideToolCall(
      event.toolName,
      event.input,
      activeModeName,
      activeMode,
      finishToolNames,
      ctx.cwd,
    );
    if (!decision.allowed) {
      return { block: true, reason: decision.reason };
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Confirm the mode for this turn and raise the guard so input during the
    // run (e.g. steering) cannot change it.
    modeGuardActive = true;
    if (!shouldInjectModeMessage(lastReportedModeName, activeModeName)) return;
    // Record the mode for the next turn's comparison right away; settle only
    // drops the guard.
    lastReportedModeName = activeModeName;
    return {
      message: {
        customType: "pi-tools-switch-mode",
        content: buildModeMessage(activeModeName, activeMode, ctx.cwd),
        display: true,
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Drop the guard only. The mode persists across turns until it is
    // explicitly exited (exit trigger, another mode's trigger, or the finish
    // tool's accept-and-exit).
    modeGuardActive = false;
    refreshStatus(ctx);
  });

  pi.registerCommand("ptsw-mode-list", {
    description: "List all gating modes and exit triggers",
    handler: async (args, ctx) => {
      if (rejectUnexpectedArgs(args, "/ptsw-mode-list", ctx)) return;
      const lines = Object.entries(modes).map(
        ([name, mode]) => `${name} trigger: ${mode.trigger.join(", ")}`,
      );
      lines.push(`exit trigger: ${exitTriggers.join(", ")}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ptsw-mode-show", {
    description: "Show gating mode details: /ptsw-mode-show <name>",
    getArgumentCompletions: (prefix) => {
      const items = Object.keys(modes).map((name) => ({ value: name, label: name }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name === "") {
        ctx.ui.notify("Missing mode name. Usage: /ptsw-mode-show <name>", "error");
        return;
      }
      const mode = modes[name];
      if (!mode) {
        ctx.ui.notify(`Unknown mode: ${name}`, "error");
        return;
      }
      ctx.ui.notify(
        [
          `Mode: ${name}`,
          `  trigger: ${mode.trigger.join(", ")}`,
          `  allowTools: ${mode.allowTools.length > 0 ? mode.allowTools.join(", ") : "(none)"}`,
          `  allowWriteDir: ${
            mode.allowWriteDir.length > 0 ? mode.allowWriteDir.join(", ") : "(none)"
          }`,
        ].join("\n"),
        "info",
      );
    },
  });
}

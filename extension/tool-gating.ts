/**
 * Tool gating for pi-tools-switch: prefix-triggered modes that restrict tool
 * usage. A mode is activated by an input prefix and stays active across turns
 * until it is explicitly exited (the gating exit trigger, another mode's
 * trigger, or exit_mode's "accept and exit" choice).
 *
 * Module-local state only: owns the active mode name and the
 * "pi-tools-switch-mode" status bar. No shared mutable state.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { READ_ONLY_TOOLS, isPathInDirs, resolveDir } from "./utils.ts";
import { rejectUnexpectedArgs } from "./utils-pi.ts";
import {
  MODE_MESSAGE_CUSTOM_TYPE,
  MODE_TRIGGER_CUSTOM_TYPE,
  replayLastReportedModeName,
  replayLastTriggeredModeName,
} from "./tool-gating-replay.ts";
import type { Config, GatingModeConfig } from "./config.ts";
import type { GatingStatusReader, GatingToolStatus } from "./utils-status.ts";

const MODE_STATUS_BAR_KEY = "pi-tools-switch-mode";

export const EXIT_MODE_TOOL_NAME = "exit_mode";

/**
 * Return whether a tool is allowed without a write/edit path check. This pure
 * function deliberately leaves allowWriteDir handling to its caller.
 */
export function isToolUnrestricted(
  toolName: string,
  activeMode: Pick<GatingModeConfig, "allowTools"> | null,
): boolean {
  if (!activeMode) return true;
  return (
    toolName === EXIT_MODE_TOOL_NAME ||
    READ_ONLY_TOOLS.includes(toolName) ||
    activeMode.allowTools.includes(toolName)
  );
}

/**
 * Create an immutable derived status for one tool. The function is pure: it
 * does not mutate or retain the supplied mode data.
 */
export function getGatingToolStatus(
  toolName: string,
  activeMode: Pick<GatingModeConfig, "allowTools" | "allowWriteDir"> | null,
): GatingToolStatus {
  const unrestricted = isToolUnrestricted(toolName, activeMode);
  const hasAllowedWriteDir =
    !unrestricted &&
    (toolName === "write" || toolName === "edit") &&
    (activeMode?.allowWriteDir.length ?? 0) > 0;
  return Object.freeze({ unrestricted, hasAllowedWriteDir });
}

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
    trigger: ["/plan-mode"],
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

/** Built-in gating exit-trigger prefixes, used when the config provides none. */
export const BUILTIN_GATING_EXIT_TRIGGERS: readonly string[] = ["/normal-mode"];

/**
 * Merge config exit triggers with the built-in ones: a non-empty config list
 * fully overrides the built-ins (no built-in prefix is kept); an empty config
 * list falls back to the built-in prefixes. Always returns a fresh array so
 * the built-in constant is never aliased or mutated.
 */
export function mergeGatingExitTriggers(userTriggers: readonly string[]): string[] {
  return userTriggers.length > 0 ? [...userTriggers] : [...BUILTIN_GATING_EXIT_TRIGGERS];
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

/** Render the reported and active mode names, including pending state changes. */
export function formatModeStatus(
  lastReported: string | null | undefined,
  active: string | null,
): string {
  const formatName = (name: string | null | undefined): string => {
    if (name === null) return "-";
    if (name === undefined) return "?";
    return name;
  };
  if (lastReported === active) return `[M: ${formatName(active)}]`;
  return `[M: ${formatName(lastReported)} => ${formatName(active)}]`;
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
 * Blocked reason for other tools: lists exit_mode, read-only tools, and mode
 * allowTools, then notes that write/edit are conditionally allowed.
 */
export function buildBlockReason(modeName: string, mode: GatingModeConfig): string {
  const allowed = [...new Set([EXIT_MODE_TOOL_NAME, ...READ_ONLY_TOOLS, ...mode.allowTools])];
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
  modeName: string | null,
  mode: GatingModeConfig | null,
  cwd: string,
): string {
  if (!modeName || !mode) {
    return `You are not currently in any gating mode. You may call any available tool.`;
  }
  const allowed = [...new Set([EXIT_MODE_TOOL_NAME, ...READ_ONLY_TOOLS, ...mode.allowTools])];
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
 * always when the previously reported state is unknown, and whenever the
 * active mode differs from the mode reported by the previous injected message.
 */
export function shouldInjectModeMessage(
  lastReportedModeName: string | null | undefined,
  activeModeName: string | null,
): boolean {
  return lastReportedModeName === undefined || activeModeName !== lastReportedModeName;
}

/** Format a persisted trigger entry as a compact TUI history line. */
export function formatModeTriggerEntry(data: unknown): string {
  if (data !== null && typeof data === "object" && "modeName" in data) {
    if (typeof data.modeName === "string") {
      return `Triggered: tool gating enabled. (mode: ${data.modeName})`;
    }
    if (data.modeName === null) return "Triggered: tool gating disabled.";
  }
  return "Triggered: tool gating record is invalid.";
}

interface GatingDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a tool call is allowed under the active gating mode.
 * Check order: inactive -> exit_mode -> read-only -> allowTools -> write/edit
 * with allowWriteDir -> block everything else.
 */
export function decideToolCall(
  toolName: string,
  input: unknown,
  modeName: string | null,
  mode: GatingModeConfig | null,
  cwd: string,
): GatingDecision {
  if (!mode || !modeName) return { allowed: true };
  if (isToolUnrestricted(toolName, mode)) return { allowed: true };
  if (toolName === "write" || toolName === "edit") {
    const path = (input as { path?: unknown } | undefined)?.path;
    try {
      if (typeof path === "string" && isPathInDirs(path, mode.allowWriteDir, cwd)) {
        return { allowed: true };
      }
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { allowed: false, reason: buildWriteReason(modeName, mode, cwd) };
  }
  return { allowed: false, reason: buildBlockReason(modeName, mode) };
}

export function register(pi: ExtensionAPI, getConfig: () => Config): GatingStatusReader {
  // Merged gating modes cached once at load time (rebuilt on extension reload).
  const modes = mergeGatingModes(getConfig().gatingModes);
  // Exit-trigger prefixes cached once at load time (rebuilt on extension reload):
  // an empty config list falls back to the built-in prefixes, a non-empty one
  // fully overrides them.
  const exitTriggers = mergeGatingExitTriggers(getConfig().gatingExitTrigger);

  let activeModeName: string | null = null;
  let activeMode: GatingModeConfig | null = null;
  // Start unknown until session_start restores the active branch. null means
  // no gating mode; undefined means the persisted state could not be recognized.
  let lastReportedModeName: string | null | undefined = undefined;
  // Guard flag: raised once the mode is confirmed at before_agent_start and
  // cleared at agent_settled. While raised, input events (e.g. steering
  // input) must not change the mode.
  let modeGuardActive = false;

  const readGatingStatus: GatingStatusReader = (toolName) =>
    getGatingToolStatus(toolName, activeMode);

  const refreshStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(MODE_STATUS_BAR_KEY, formatModeStatus(lastReportedModeName, activeModeName));
  };

  const restoreReportedMode = (ctx: ExtensionContext): void => {
    const result = replayLastReportedModeName(ctx);
    if (result.error) {
      ctx.ui.notify(`tools-switch: failed to restore gating state: ${result.error}`, "error");
    }
    lastReportedModeName = result.modeName;
    refreshStatus(ctx);
  };

  /** Apply a configured mode (or no mode), returning false for an unknown name. */
  const setMode = (name: string | null, ctx: ExtensionContext): boolean => {
    if (name === null) {
      activeModeName = null;
      activeMode = null;
    } else {
      const mode = modes[name];
      if (!mode) return false;
      activeModeName = name;
      activeMode = mode;
    }
    refreshStatus(ctx);
    return true;
  };

  const appendModeTrigger = (name: string | null, ctx: ExtensionContext): void => {
    try {
      pi.appendEntry(MODE_TRIGGER_CUSTOM_TYPE, { modeName: name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`tools-switch: failed to persist gating trigger: ${message}`, "error");
    }
  };

  /** Change modes from a user/runtime trigger and persist actual transitions. */
  const triggerMode = (name: string | null, ctx: ExtensionContext): boolean => {
    if (name === activeModeName) return false;
    if (!setMode(name, ctx)) return false;
    appendModeTrigger(name, ctx);
    return true;
  };

  const restoreTriggeredMode = (ctx: ExtensionContext): void => {
    const result = replayLastTriggeredModeName(ctx);
    if (result.modeName === undefined) {
      const reason = result.error ?? "invalid trigger record";
      ctx.ui.notify(`tools-switch: failed to restore gating mode: ${reason}`, "error");
      return;
    }
    if (!setMode(result.modeName, ctx)) {
      ctx.ui.notify(
        `tools-switch: failed to restore gating mode: unknown mode "${result.modeName}"`,
        "error",
      );
    }
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

        const accept = (closing: boolean): {
          content: { type: "text"; text: string }[];
          details: Record<string, unknown>;
          terminate: true;
        } => {
          ctx.ui.notify(params.summary, "info");
          if (closing) triggerMode(null, ctx);
          const text = closing
            ? `The user has accepted. Exiting ${modeName} mode now.`
            : `The user has accepted. You are still in ${modeName} mode.`;
          return {
            content: [{ type: "text", text }],
            details: { summary: params.summary },
            terminate: true,
          };
        };
        if (!ctx.hasUI) return accept(true);
        const choice = await ctx.ui.select(
          `${modeName} mode: accept and exit, accept and stay, or refine?\n${params.summary}`,
          ["Accept and exit mode", "Accept and stay in mode", "Refine"],
        );
        if (choice === "Accept and stay in mode") return accept(false);
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
        return accept(true);
      },
    });
  };

  // Register one stable completion tool for every gating mode. Mode changes
  // update only module-local state and never alter the active tool schema.
  registerExitModeTool();

  pi.registerEntryRenderer(MODE_TRIGGER_CUSTOM_TYPE, (entry, _options, theme) =>
    new Text(theme.fg("muted", formatModeTriggerEntry(entry.data)), 0, 0),
  );

  pi.on("session_start", async (_event, ctx) => {
    // Restore the report state before the active mode so a matching trigger
    // record does not require another mode-state message on the next turn.
    modeGuardActive = false;
    restoreReportedMode(ctx);
    restoreTriggeredMode(ctx);
    ensureExitModeActive();
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreReportedMode(ctx);
    restoreTriggeredMode(ctx);
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
      triggerMode(modeMatch, ctx);
      return;
    }
    if (exitMatch) {
      triggerMode(null, ctx);
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
    refreshStatus(ctx);
    return {
      message: {
        customType: MODE_MESSAGE_CUSTOM_TYPE,
        content: buildModeMessage(activeModeName, activeMode, ctx.cwd),
        display: true,
        // activeModeName is always JSON-safe: string for a mode or null for no mode.
        details: { modeName: activeModeName },
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Drop the guard only. The mode persists across turns until it is
    // explicitly exited (exit trigger, another mode's trigger, or exit_mode's
    // accept-and-exit).
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

  return readGatingStatus;
}


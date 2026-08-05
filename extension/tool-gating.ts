/**
 * Tool gating for pi-tools-switch: prefix-triggered modes that restrict tool
 * usage for one agent interaction (input -> agent_settled).
 *
 * Module-local state only: owns the active mode name and the
 * "pi-tools-switch-mode" status bar. No shared mutable state.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_ONLY_TOOLS, isPathInDirs, resolveDir } from "./utils.ts";
import type { Config, GatingModeConfig } from "./config.ts";

const MODE_STATUS_BAR_KEY = "pi-tools-switch-mode";

/** Built-in gating modes, keyed by mode name. User modes with the same name override them. */
export const BUILTIN_GATING_MODES: Record<string, GatingModeConfig> = {
  plan: {
    trigger: "/skill:plan-mode",
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

/** Return the first mode whose trigger is a prefix of `text`, if any. */
export function matchTrigger(
  text: string,
  modes: Record<string, GatingModeConfig>,
): string | undefined {
  for (const [name, mode] of Object.entries(modes)) {
    if (mode.trigger.length > 0 && text.startsWith(mode.trigger)) return name;
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

  let activeModeName: string | undefined;
  let activeMode: GatingModeConfig | undefined;

  const getFinishToolNames = (): string[] =>
    Object.keys(modes).map((name) => `finish_${name}_mode`);

  const refreshStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(MODE_STATUS_BAR_KEY, formatModeStatus(activeModeName));
  };

  const removeFinishTools = (): void => {
    const finishTools = new Set(getFinishToolNames());
    pi.setActiveTools(pi.getActiveTools().filter((tool) => !finishTools.has(tool)));
  };

  const setMode = (name: string | undefined, ctx: ExtensionContext): void => {
    if (name === undefined) {
      activeModeName = undefined;
      activeMode = undefined;
      removeFinishTools();
    } else {
      const mode = modes[name];
      if (!mode) return;
      activeModeName = name;
      activeMode = mode;
      const finishTool = `finish_${name}_mode`;
      if (!pi.getActiveTools().includes(finishTool)) {
        pi.setActiveTools([...pi.getActiveTools(), finishTool]);
      }
    }
    refreshStatus(ctx);
  };

  const registerFinishTool = (modeName: string, mode: GatingModeConfig): void => {
    const toolName = `finish_${modeName}_mode`;
    pi.registerTool({
      name: toolName,
      label: `Finish ${modeName} mode`,
      description: `Finish ${modeName} mode: submit the final summary.`,
      parameters: Type.Object({
        summary: Type.String({ description: "Summary of the completed mode work." }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const accept = (): {
          content: { type: "text"; text: string }[];
          details: Record<string, unknown>;
          terminate: true;
        } => {
          ctx.ui.notify(params.summary, "info");
          return {
            content: [
              { type: "text", text: `The user has accepted. Exiting ${modeName} mode now.` },
            ],
            details: { summary: params.summary },
            terminate: true,
          };
        };
        if (!ctx.hasUI) return accept();
        const choice = await ctx.ui.select(
          `${modeName} mode: accept the summary or refine it?\n${params.summary}`,
          ["Accept", "Refine"],
        );
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
        return accept();
      },
    });
  };

  // Register finish tools at extension load time (factory), once per instance.
  for (const [name, mode] of Object.entries(modes)) {
    registerFinishTool(name, mode);
  }

  pi.on("session_start", async (_event, ctx) => {
    // Reset gating state through the single state-change entry point.
    setMode(undefined, ctx);
  });

  pi.on("input", async (event, ctx) => {
    const name = matchTrigger(event.text, modes);
    if (name) setMode(name, ctx);
    else refreshStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activeMode || !activeModeName) return;
    const decision = decideToolCall(
      event.toolName,
      event.input,
      activeModeName,
      activeMode,
      getFinishToolNames(),
      ctx.cwd,
    );
    if (!decision.allowed) {
      return { block: true, reason: decision.reason };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    setMode(undefined, ctx);
  });

  pi.registerCommand("tools-mode-info", {
    description: "Show gating modes, or one mode's details: /tools-mode-info [<name>]",
    getArgumentCompletions: (prefix) => {
      const items = Object.keys(modes).map((name) => ({ value: name, label: name }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const name = args?.trim() ?? "";
      if (name === "") {
        const lines = Object.entries(modes).map(([n, mode]) => {
          const allowTools =
            mode.allowTools.length > 0 ? `, allow: ${mode.allowTools.join(", ")}` : "";
          const dirs =
            mode.allowWriteDir.length > 0 ? `, write: ${mode.allowWriteDir.join(", ")}` : "";
          return `${n}  trigger: ${mode.trigger}${allowTools}${dirs}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
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
          `  trigger: ${mode.trigger}`,
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

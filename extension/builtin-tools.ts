/**
 * Built-in tools management for pi-tools-switch: tool on/off state, status
 * bar, commands, presets, and default-preset auto-activation at session start.
 *
 * Module-local state only: reads tool state via pi.getActiveTools() and owns
 * the "pi-tools-switch-status" status bar. No shared mutable state.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_SET,
  isBuiltinToolName,
  isValidPresetName,
  type BuiltinToolName,
} from "./utils.ts";
import type { Config } from "./config.ts";
import { rejectUnexpectedArgs } from "./utils-pi.ts";

const STATUS_BAR_KEY = "pi-tools-switch-status";

const STATUS_CHARS: Record<BuiltinToolName, string> = {
  read: "R",
  write: "W",
  edit: "E",
  bash: "B",
  find: "F",
  grep: "G",
  ls: "L",
};

/** Built-in presets. User presets with the same name override these. */
export const BUILTIN_PRESETS: Record<string, readonly string[]> = {
  read: ["read"],
  explore: ["read", "find", "grep", "ls"],
  default: ["read", "write", "edit", "bash"],
  full: [...BUILTIN_TOOL_NAMES],
};

/** Merge built-in presets with user presets (user wins on name collision). */
export function mergePresets(userPresets: Record<string, string[]>): Record<string, readonly string[]> {
  return { ...BUILTIN_PRESETS, ...userPresets };
}

/** Status bar text: [RWEBFGL], '-' for disabled built-in tools. */
export function computeStatusBar(activeTools: Iterable<string>): string {
  const active = new Set(activeTools);
  return (
    "[" +
    BUILTIN_TOOL_NAMES.map((tool) => (active.has(tool) ? STATUS_CHARS[tool] : "-")).join("") +
    "]"
  );
}

/**
 * Compute the next active-tool list when applying a preset: built-in tools are
 * replaced by the preset's set, external tools are kept untouched.
 */
export function applyPreset(activeTools: readonly string[], presetTools: readonly string[]): string[] {
  const external = activeTools.filter((name) => !BUILTIN_TOOL_SET.has(name));
  return [...external, ...new Set(presetTools)];
}

/**
 * Result of validating a list of tool names: `ok` is true when every name is a
 * built-in tool; `tools` carries the valid names, `invalid` the invalid ones.
 */
interface ToolValidationResult {
  ok: boolean;
  tools: BuiltinToolName[];
  invalid: string[];
}

/** Validate tool names against the built-in list. Never throws. */
export function validateBuiltinTools(names: readonly string[]): ToolValidationResult {
  const tools: BuiltinToolName[] = [];
  const invalid: string[] = [];
  for (const name of names) {
    if (isBuiltinToolName(name)) tools.push(name);
    else invalid.push(name);
  }
  return { ok: invalid.length === 0, tools, invalid };
}

/**
 * Compute the next active-tool list when enabling/disabling built-in tools:
 * union with the tools when enabling, difference when disabling. Preserves
 * external tools and dedupes the result.
 */
export function toggleBuiltinTools(
  activeTools: readonly string[],
  tools: readonly BuiltinToolName[],
  enabled: boolean,
): string[] {
  const target = new Set(tools);
  const next = new Set(activeTools);
  for (const tool of target) {
    if (enabled) next.add(tool);
    else next.delete(tool);
  }
  return [...next];
}

/** One line for the preset list: `[R---FGL] name` (shorthand first for alignment). */
export function formatPresetLine(name: string, tools: readonly string[]): string {
  return `${computeStatusBar(tools)} ${name}`;
}

/** Status bar text for the active default preset: [D: <name>] or [D: -]. */
export function formatDefaultStatus(name: string | undefined): string {
  return `[D: ${name ?? "-"}]`;
}

/** Resolution of the configured default preset. */
export interface EffectiveDefaultPreset {
  /** Effective preset name, or undefined when not effective. */
  preset: string | undefined;
  /** The configured defaultPreset value (undefined when not configured). */
  configured: string | undefined;
  /** True when defaultPreset was configured but does not exist (invalid). */
  invalid: boolean;
}

/**
 * Resolve the effective default preset from the (already merged) presets: not
 * effective when no defaultPreset is configured or when the configured preset
 * does not exist. Subagents are excluded at the factory layer (index.ts skips
 * registering this module for subagents), so no subagent branch is needed
 * here. Runs once at the factory layer; the result is stable for the process.
 */
export function getEffectiveDefaultPreset(
  defaultPreset: string | undefined,
  presets: Record<string, readonly string[]>,
): EffectiveDefaultPreset {
  if (defaultPreset === undefined) {
    return { preset: undefined, configured: undefined, invalid: false };
  }
  if (presets[defaultPreset]) {
    return { preset: defaultPreset, configured: defaultPreset, invalid: false };
  }
  return { preset: undefined, configured: defaultPreset, invalid: true };
}

/** Text block listing all tools with their on/off state. */
export function formatToolsStatus(
  activeTools: readonly string[],
  allTools: readonly { name: string }[],
): string {
  const active = new Set(activeTools);
  return allTools
    .map((tool) => {
      const state = active.has(tool.name) ? "[+]" : "[ ]";
      const kind = isBuiltinToolName(tool.name) ? " (built-in)" : "";
      return `${state} ${tool.name}${kind}`;
    })
    .join("\n");
}

export function builtinToolCompletions(prefix: string): AutocompleteItem[] | null {
  const parts = prefix.split(/\s+/);
  // Drop only trailing empty tokens produced by trailing whitespace. The
  // original prefix remains unchanged so completion values can preserve the
  // full accumulated argument list Pi replaces in the editor.
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();

  if (parts.length === 0) {
    return BUILTIN_TOOL_NAMES.map((tool) => ({ value: tool, label: tool }));
  }

  const completeTokens = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  if (completeTokens.some((tool) => !isBuiltinToolName(tool))) return null;

  // Without trailing whitespace, a complete tool name remains in the current
  // completion stage. Requiring a space before offering another tool preserves
  // the existing workaround for pi-tui cursor behavior.
  if (isBuiltinToolName(last) && !prefix.endsWith(" ")) {
    const items = BUILTIN_TOOL_NAMES.filter((tool) => tool.startsWith(last)).map((tool) => ({
      value: [...completeTokens, tool].join(" "),
      label: tool,
    }));
    const filtered = items.filter((item) => item.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }

  const selected = isBuiltinToolName(last) ? [...completeTokens, last] : completeTokens;
  const used = new Set(selected);
  const remaining = BUILTIN_TOOL_NAMES.filter((tool) => !used.has(tool));
  if (remaining.length === 0) return null;

  const items = remaining.map((tool) => ({
    value: [...selected, tool].join(" "),
    label: tool,
  }));
  const filtered = items.filter((item) => item.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

function presetNameCompletions(
  prefix: string,
  presets: Record<string, readonly string[]>,
): AutocompleteItem[] | null {
  const items = Object.keys(presets).map((name) => ({ value: name, label: name }));
  const filtered = items.filter((item) => item.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

export function register(pi: ExtensionAPI, getConfig: () => Config): void {
  // Config-derived state cached once at load time (rebuilt on extension reload).
  const presets = mergePresets(getConfig().presets);
  // Configured default preset resolved once at the factory layer. It is the
  // immutable baseline for each new session; index.ts never registers this
  // module for subagents.
  const effectiveDefault = getEffectiveDefaultPreset(getConfig().defaultPreset, presets);
  // This runtime value starts from the configured default, but a successful
  // preset-apply command may change it for the current session only.
  let currentEffectiveDefaultPreset = effectiveDefault.preset;

  const refreshStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_BAR_KEY,
      `${computeStatusBar(pi.getActiveTools())} ${formatDefaultStatus(currentEffectiveDefaultPreset)}`,
    );
  };

  const applyPresetByName = (name: string): { next: string[]; ok: boolean; error?: string } => {
    const tools = presets[name];
    if (!tools) return { next: [], ok: false, error: `Unknown preset: ${name}` };
    const next = applyPreset(pi.getActiveTools(), tools);
    pi.setActiveTools(next);
    return { next, ok: true };
  };

  pi.registerCommand("ptsw-builtin-status", {
    description: "Show all tool status",
    handler: async (args, ctx) => {
      if (rejectUnexpectedArgs(args, "/ptsw-builtin-status", ctx)) return;
      ctx.ui.notify(formatToolsStatus(pi.getActiveTools(), pi.getAllTools()), "info");
    },
  });

  const registerToolToggleCommand = (enabled: boolean): void => {
    const action = enabled ? "enable" : "disable";
    const commandName = `ptsw-builtin-${action}`;
    pi.registerCommand(commandName, {
      description: `${enabled ? "Enable" : "Disable"} one or more built-in tools: /${commandName} <tool> [...]`,
      getArgumentCompletions: builtinToolCompletions,
      handler: async (args, ctx) => {
        const tools = args.trim().split(/\s+/).filter(Boolean);
        if (tools.length === 0) {
          ctx.ui.notify(
            `Missing tool name. Usage: /${commandName} <tool> [<tool> ...]`,
            "error",
          );
          return;
        }

        // Validate every tool first; abort the whole command on any invalid name.
        const validation = validateBuiltinTools(tools);
        if (!validation.ok) {
          ctx.ui.notify(
            `Invalid tool(s): ${validation.invalid.join(", ")}. Available: ${BUILTIN_TOOL_NAMES.join(", ")}`,
            "error",
          );
          return;
        }

        const next = toggleBuiltinTools(pi.getActiveTools(), validation.tools, enabled);
        pi.setActiveTools(next);
        refreshStatus(ctx);
        ctx.ui.notify(
          `${enabled ? "Enabled" : "Disabled"} ${tools.join(", ")}. Status: ${computeStatusBar(next)}`,
          "info",
        );
      },
    });
  };

  registerToolToggleCommand(true);
  registerToolToggleCommand(false);

  pi.registerCommand("ptsw-builtin-reset", {
    description: "Restore the effective default preset",
    handler: async (args, ctx) => {
      if (rejectUnexpectedArgs(args, "/ptsw-builtin-reset", ctx)) return;
      if (!currentEffectiveDefaultPreset) {
        ctx.ui.notify("No default preset configured", "warning");
        return;
      }
      const result = applyPresetByName(currentEffectiveDefaultPreset);
      if (!result.ok) {
        ctx.ui.notify(result.error ?? "Unknown preset", "error");
        return;
      }
      refreshStatus(ctx);
      ctx.ui.notify(
        `Restored preset "${currentEffectiveDefaultPreset}" (${computeStatusBar(result.next)})`,
        "info",
      );
    },
  });

  pi.registerCommand("ptsw-preset-list", {
    description: "List all tool presets",
    handler: async (args, ctx) => {
      if (rejectUnexpectedArgs(args, "/ptsw-preset-list", ctx)) return;
      const lines = Object.entries(presets).map(([name, tools]) => formatPresetLine(name, tools));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ptsw-preset-apply", {
    description: "Apply a tool preset: /ptsw-preset-apply <name>",
    getArgumentCompletions: (prefix) => presetNameCompletions(prefix, presets),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name === "") {
        ctx.ui.notify("Missing preset name. Usage: /ptsw-preset-apply <name>", "error");
        return;
      }
      if (!isValidPresetName(name)) {
        ctx.ui.notify(
          `Invalid preset name "${name}" (must match [a-z][a-z0-9_-]*)`,
          "error",
        );
        return;
      }
      const result = applyPresetByName(name);
      if (!result.ok) {
        ctx.ui.notify(result.error ?? "Unknown preset", "error");
        return;
      }
      currentEffectiveDefaultPreset = name;
      refreshStatus(ctx);
      ctx.ui.notify(`Preset "${name}" applied. Status: ${computeStatusBar(result.next)}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentEffectiveDefaultPreset = effectiveDefault.preset;
    if (currentEffectiveDefaultPreset) {
      const result = applyPresetByName(currentEffectiveDefaultPreset);
      if (!result.ok) {
        ctx.ui.notify(result.error ?? "Unknown preset", "error");
      }
    } else if (effectiveDefault.invalid) {
      // Configured default preset does not exist.
      ctx.ui.notify(`Unknown preset: ${effectiveDefault.configured}`, "error");
    }
    refreshStatus(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => refreshStatus(ctx));
  pi.on("agent_settled", async (_event, ctx) => refreshStatus(ctx));
  pi.on("input", async (_event, ctx) => refreshStatus(ctx));
}

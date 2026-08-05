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

export const STATUS_BAR_KEY = "pi-tools-switch-status";
export const OUTPUT_ENTRY_TYPE = "pi-tools-switch-output";

const STATUS_CHARS: Record<BuiltinToolName, string> = {
  read: "R",
  write: "W",
  edit: "E",
  bash: "B",
  find: "F",
  grep: "G",
  ls: "L",
};

/** Built-in subagent detection environment variables. */
export const BUILTIN_SUBAGENT_ENV_VARS: readonly string[] = [
  // pi-agent-router (original)
  "PI_IS_SUBAGENT",
  "PI_SUBAGENT_SESSION_ID",
  "PI_AGENT_ROUTER_SUBAGENT",
  // nicobailon/pi-subagents
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_DEPTH",
  // HazAT/pi-interactive-subagents
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
];

/** Built-in presets. User presets with the same name override these. */
export const BUILTIN_PRESETS: Record<string, readonly string[]> = {
  read: ["read"],
  explore: ["read", "find", "grep", "ls"],
  default: ["read", "write", "edit", "bash"],
  full: [...BUILTIN_TOOL_NAMES],
};

/** True when any known subagent env var (built-in or user-extended) is set. */
export function isSubagentEnv(env: NodeJS.ProcessEnv, extraVars: readonly string[]): boolean {
  const vars = [...BUILTIN_SUBAGENT_ENV_VARS, ...extraVars];
  return vars.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}

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
export interface ToolValidationResult {
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

/** One line for the preset list: `name  [R---FGL]`. */
export function formatPresetLine(name: string, tools: readonly string[]): string {
  return `${name}  ${computeStatusBar(tools)}`;
}

/** Text block listing all tools with their on/off state. */
export function formatToolsStatus(
  activeTools: readonly string[],
  allTools: readonly { name: string }[],
): string {
  const active = new Set(activeTools);
  return allTools
    .map((tool) => {
      const state = active.has(tool.name) ? "[on] " : "[off]";
      const kind = isBuiltinToolName(tool.name) ? " (built-in)" : "";
      return `${state} ${tool.name}${kind}`;
    })
    .join("\n");
}

function toolsSwitchCompletions(prefix: string): AutocompleteItem[] | null {
  const trimmed = prefix.trim();
  const parts = trimmed.split(/\s+/);
  const subcommands = ["enable", "disable"];
  if (parts.length <= 1 || (parts[0] !== "enable" && parts[0] !== "disable")) {
    const items = subcommands.map((sub) => ({ value: sub, label: sub }));
    const filtered = items.filter((item) => item.value.startsWith(trimmed));
    return filtered.length > 0 ? filtered : null;
  }
  const items = BUILTIN_TOOL_NAMES.map((tool) => ({
    value: `${parts[0]} ${tool}`,
    label: tool,
  }));
  const filtered = items.filter((item) => item.value.startsWith(trimmed));
  return filtered.length > 0 ? filtered : null;
}

function presetNameCompletions(prefix: string, config: Config): AutocompleteItem[] | null {
  const presets = mergePresets(config.presets);
  const items = Object.keys(presets).map((name) => ({ value: name, label: name }));
  const filtered = items.filter((item) => item.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

export function register(pi: ExtensionAPI, getConfig: () => Config): void {
  const refreshStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_BAR_KEY, computeStatusBar(pi.getActiveTools()));
  };

  const applyPresetByName = (name: string): { next: string[]; ok: boolean; error?: string } => {
    const presets = mergePresets(getConfig().presets);
    const tools = presets[name];
    if (!tools) return { next: [], ok: false, error: `Unknown preset: ${name}` };
    const next = applyPreset(pi.getActiveTools(), tools);
    pi.setActiveTools(next);
    return { next, ok: true };
  };

  pi.registerCommand("tools-switch", {
    description: "Show tool status, or enable/disable built-in tools: /tools-switch [enable|disable <tool> ...]",
    getArgumentCompletions: toolsSwitchCompletions,
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const [sub, ...tools] = parts;
      if (!sub) {
        ctx.ui.notify(formatToolsStatus(pi.getActiveTools(), pi.getAllTools()), "info");
        return;
      }
      if (sub !== "enable" && sub !== "disable") {
        ctx.ui.notify(
          `Unknown subcommand "${sub}". Usage: /tools-switch [enable|disable <tool> ...]`,
          "error",
        );
        return;
      }
      if (tools.length === 0) {
        ctx.ui.notify(
          `Missing tool name. Usage: /tools-switch ${sub} <tool> [<tool> ...]`,
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
      const next = toggleBuiltinTools(pi.getActiveTools(), validation.tools, sub === "enable");
      pi.setActiveTools(next);
      refreshStatus(ctx);
      ctx.ui.notify(`${sub}d ${tools.join(", ")}. Status: ${computeStatusBar(next)}`, "info");
    },
  });

  pi.registerCommand("tools-preset", {
    description: "List presets, or apply one: /tools-preset <name>",
    getArgumentCompletions: (prefix) => presetNameCompletions(prefix, getConfig()),
    handler: async (args, ctx) => {
      const presets = mergePresets(getConfig().presets);
      const name = args?.trim() ?? "";
      if (name === "") {
        const lines = Object.entries(presets).map(([n, tools]) => formatPresetLine(n, tools));
        ctx.ui.notify(lines.join("\n"), "info");
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
      refreshStatus(ctx);
      ctx.ui.notify(`Preset "${name}" applied. Status: ${computeStatusBar(result.next)}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = getConfig();
    const subagent = isSubagentEnv(process.env, config.subagentEnvVars);
    if (!subagent && config.defaultPreset) {
      const result = applyPresetByName(config.defaultPreset);
      if (result.ok) {
        pi.appendEntry(OUTPUT_ENTRY_TYPE, {
          lines: [`Applied preset "${config.defaultPreset}" (${computeStatusBar(result.next)})`],
        });
      } else {
        ctx.ui.notify(result.error ?? "Unknown preset", "error");
      }
    }
    refreshStatus(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => refreshStatus(ctx));
  pi.on("agent_settled", async (_event, ctx) => refreshStatus(ctx));
  pi.on("input", async (_event, ctx) => refreshStatus(ctx));
}

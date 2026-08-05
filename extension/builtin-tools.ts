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

/** Resolution of the configured default preset for the current session. */
export interface EffectiveDefaultPreset {
  /** Effective preset name, or undefined when not effective. */
  preset: string | undefined;
  /** True when defaultPreset was configured but does not exist (invalid). */
  invalid: boolean;
}

/**
 * Resolve the effective default preset for the current session from the
 * (already merged) presets: not effective when running as a subagent, when no
 * defaultPreset is configured, or when the configured preset does not exist.
 */
export function getEffectiveDefaultPreset(
  defaultPreset: string | undefined,
  presets: Record<string, readonly string[]>,
  subagent: boolean,
): EffectiveDefaultPreset {
  if (subagent || defaultPreset === undefined) {
    return { preset: undefined, invalid: false };
  }
  if (presets[defaultPreset]) {
    return { preset: defaultPreset, invalid: false };
  }
  return { preset: undefined, invalid: true };
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

export function toolsSwitchCompletions(prefix: string): AutocompleteItem[] | null {
  const parts = prefix.split(/\s+/);
  const first = parts[0] ?? "";
  if (parts.length <= 1) {
    // Subcommand stage: enable/disable carry a trailing space (more arguments
    // follow), default does not. The prefix is not trimmed so the space
    // survives the round-trip into the tool stage.
    const items = [
      { value: "enable ", label: "enable" },
      { value: "disable ", label: "disable" },
      { value: "default", label: "default" },
    ];
    const filtered = items.filter((item) => item.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }
  if (first !== "enable" && first !== "disable") return null;

  // Tool stage: append-only completion. Each value carries the full
  // accumulated argument list (subcommand + already-chosen tools + the new
  // tool) because the autocomplete replaces the whole prefix. Already-chosen
  // tools are excluded so each tool can be added at most once. All tokens
  // except the last one must be complete valid tool names; the last token is
  // treated as an in-progress prefix and only used for filtering.
  const tokens = parts.slice(1);
  // Drop only the trailing empty token produced by a trailing space.
  while (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  if (tokens.length === 0) {
    const items = BUILTIN_TOOL_NAMES.map((tool) => ({
      value: `${first} ${tool}`,
      label: tool,
    }));
    const filtered = items.filter((item) => item.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }
  const completeTokens = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1];
  if (completeTokens.some((tool) => !isBuiltinToolName(tool))) return null;

  // A complete tool name without a trailing space is still being typed (or
  // just finished): complete it without appending, keeping any earlier tools
  // in the accumulated value. The user must type a space to confirm it and
  // move into the append stage. This also avoids the pi-tui cursor bug that
  // leaves completions unresponsive after selection.
  if (isBuiltinToolName(last) && !prefix.endsWith(" ")) {
    const items = BUILTIN_TOOL_NAMES.filter((tool) => tool.startsWith(last)).map((tool) => ({
      value: `${first} ${[...completeTokens, tool].join(" ")}`,
      label: tool,
    }));
    const filtered = items.filter((item) => item.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }

  // Append stage: each value carries the full accumulated argument list
  // (subcommand + already-chosen tools + the new tool) because the
  // autocomplete replaces the whole prefix. Already-chosen tools are excluded
  // so each tool can be added at most once.
  const used = new Set(completeTokens);
  if (isBuiltinToolName(last)) used.add(last);
  const remaining = BUILTIN_TOOL_NAMES.filter((tool) => !used.has(tool));
  if (remaining.length === 0) return null;
  const items = remaining.map((tool) => ({
    value: `${first} ${[...used, tool].join(" ")}`,
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
  const subagentEnvVars = getConfig().subagentEnvVars;
  const defaultPreset = getConfig().defaultPreset;

  const refreshStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_BAR_KEY,
      `${computeStatusBar(pi.getActiveTools())} ${formatDefaultStatus(effectiveDefaultPreset)}`,
    );
  };

  // Effective default preset cached at session start (undefined when not
  // configured, invalid, or skipped for subagents).
  let effectiveDefaultPreset: string | undefined;

  const applyPresetByName = (name: string): { next: string[]; ok: boolean; error?: string } => {
    const tools = presets[name];
    if (!tools) return { next: [], ok: false, error: `Unknown preset: ${name}` };
    const next = applyPreset(pi.getActiveTools(), tools);
    pi.setActiveTools(next);
    return { next, ok: true };
  };

  pi.registerCommand("tools-switch", {
    description:
      "Show tool status, or run a subcommand: enable <tool> ... | disable <tool> ... | default",
    getArgumentCompletions: toolsSwitchCompletions,
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const [sub, ...tools] = parts;
      if (!sub) {
        ctx.ui.notify(formatToolsStatus(pi.getActiveTools(), pi.getAllTools()), "info");
        return;
      }
      if (sub === "default") {
        if (!effectiveDefaultPreset) {
          ctx.ui.notify("No default preset configured", "warning");
          return;
        }
        const result = applyPresetByName(effectiveDefaultPreset);
        if (!result.ok) {
          ctx.ui.notify(result.error ?? "Unknown preset", "error");
          return;
        }
        refreshStatus(ctx);
        ctx.ui.notify(
          `Restored preset "${effectiveDefaultPreset}" (${computeStatusBar(result.next)})`,
          "info",
        );
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
    getArgumentCompletions: (prefix) => presetNameCompletions(prefix, presets),
    handler: async (args, ctx) => {
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
    const subagent = isSubagentEnv(process.env, subagentEnvVars);
    const effective = getEffectiveDefaultPreset(defaultPreset, presets, subagent);
    effectiveDefaultPreset = effective.preset;
    if (effective.preset) {
      const result = applyPresetByName(effective.preset);
      if (!result.ok) {
        ctx.ui.notify(result.error ?? "Unknown preset", "error");
      }
    } else if (effective.invalid) {
      // Configured default preset does not exist.
      ctx.ui.notify(`Unknown preset: ${defaultPreset}`, "error");
    }
    refreshStatus(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => refreshStatus(ctx));
  pi.on("agent_settled", async (_event, ctx) => refreshStatus(ctx));
  pi.on("input", async (_event, ctx) => refreshStatus(ctx));
}

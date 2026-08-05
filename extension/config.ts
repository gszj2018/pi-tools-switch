/**
 * Configuration loading for pi-tools-switch.
 *
 * Stateless library module: provides config types and loading functions only,
 * and holds no module state. The extension entry (index.ts) loads the config
 * at startup and injects it into feature modules via the getConfig callback.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_TOOL_NAMES, isValidPresetName, type BuiltinToolName } from "./utils.ts";

export const CONFIG_FILE_NAME = "tools-switch.json";

export interface ToolGuideConfig {
  enabled: boolean;
}

export interface GatingModeConfig {
  trigger: string;
  allowTools: string[];
  allowWriteDir: string[];
}

export interface Config {
  /** User-defined presets. Names matching built-in presets override them. */
  presets: Record<string, string[]>;
  /** Preset to activate automatically at session start (optional). */
  defaultPreset?: string;
  /** Tool guide system prompt configuration. */
  toolGuide: ToolGuideConfig;
  /** Additional env vars that mark a subagent context. */
  subagentEnvVars: string[];
  /** User-defined gating modes. Names matching built-in modes override them. */
  gatingModes: Record<string, GatingModeConfig>;
}

export const DEFAULT_CONFIG: Config = {
  presets: {},
  toolGuide: { enabled: true },
  subagentEnvVars: [],
  gatingModes: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizePresets(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const presets: Record<string, string[]> = {};
  for (const [name, tools] of Object.entries(value)) {
    if (!isValidPresetName(name) || !Array.isArray(tools)) continue;
    const valid = tools.filter(
      (tool): tool is BuiltinToolName =>
        typeof tool === "string" && (BUILTIN_TOOL_NAMES as readonly string[]).includes(tool),
    );
    presets[name] = [...new Set(valid)];
  }
  return presets;
}

function normalizeGatingMode(value: unknown): GatingModeConfig | null {
  if (!isRecord(value)) return null;
  const { trigger, allowTools, allowWriteDir } = value;
  if (typeof trigger !== "string" || trigger.length === 0) return null;
  return {
    trigger,
    allowTools: toStringArray(allowTools),
    allowWriteDir: toStringArray(allowWriteDir),
  };
}

function normalizeGatingModes(value: unknown): Record<string, GatingModeConfig> {
  if (!isRecord(value)) return {};
  const modes: Record<string, GatingModeConfig> = {};
  for (const [name, mode] of Object.entries(value)) {
    const normalized = normalizeGatingMode(mode);
    if (normalized) modes[name] = normalized;
  }
  return modes;
}

/**
 * Normalize raw configuration data into a fully-typed Config with defaults.
 * Invalid entries are dropped; this function never throws.
 */
export function normalizeConfig(data: unknown): Config {
  const src = isRecord(data) ? data : {};
  return {
    presets: normalizePresets(src.presets),
    defaultPreset:
      typeof src.defaultPreset === "string" && isValidPresetName(src.defaultPreset)
        ? src.defaultPreset
        : undefined,
    toolGuide:
      isRecord(src.toolGuide) && typeof src.toolGuide.enabled === "boolean"
        ? { enabled: src.toolGuide.enabled }
        : { enabled: true },
    subagentEnvVars: toStringArray(src.subagentEnvVars),
    gatingModes: normalizeGatingModes(src.gatingModes),
  };
}

/** Load and normalize the config file from an agent directory. */
export async function loadConfigFrom(agentDir: string): Promise<Config> {
  const configPath = join(agentDir, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // First run: create an empty config file.
      await mkdir(agentDir, { recursive: true });
      await writeFile(configPath, "{}\n", "utf8");
      return normalizeConfig({});
    }
    throw err;
  }

  // Treat a blank (0-byte or whitespace-only) file as missing: rewrite it as
  // a valid empty config so subsequent loads parse normally.
  if (raw.trim() === "") {
    await writeFile(configPath, "{}\n", "utf8");
    return normalizeConfig({});
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
  }
  return normalizeConfig(data);
}

/**
 * Configuration loading for pi-tools-switch.
 *
 * Stateless library module: provides config types and loading functions only,
 * and holds no module state. The extension entry (index.ts) loads the config
 * at startup and injects it into feature modules via the getConfig callback.
 *
 * Invalid config entries are normalized away (never thrown); the resulting
 * problems are collected in `errors` so the caller can surface them to the
 * user. File-level failures (unreadable file, malformed JSON) still throw.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isBuiltinToolName, isValidPresetName, type BuiltinToolName } from "./utils.ts";

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

/** A normalized config plus the problems found while normalizing it. */
export interface ConfigLoadResult {
  config: Config;
  /** Human-readable descriptions of invalid/ignored entries (empty when clean). */
  errors: string[];
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

/**
 * Coerce an unknown value to a string array. Non-array values and non-string
 * entries are dropped and reported through `errors`, prefixed by `field`.
 */
function toStringArray(value: unknown, errors: string[], field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field}: expected an array of strings, got ${typeof value}`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") result.push(item);
    else errors.push(`${field}: ignored non-string entry ${JSON.stringify(item)}`);
  }
  return result;
}

function normalizePresets(value: unknown, errors: string[]): Record<string, string[]> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push(`presets: expected an object, got ${typeof value}`);
    return {};
  }
  const presets: Record<string, string[]> = {};
  for (const [name, tools] of Object.entries(value)) {
    if (!isValidPresetName(name)) {
      errors.push(`presets["${name}"]: invalid preset name (must match [a-z][a-z0-9_-]*)`);
      continue;
    }
    if (!Array.isArray(tools)) {
      errors.push(`presets["${name}"]: expected an array of tool names, got ${typeof tools}`);
      continue;
    }
    const valid: BuiltinToolName[] = [];
    for (const tool of tools) {
      if (typeof tool === "string" && isBuiltinToolName(tool)) {
        valid.push(tool);
      } else {
        errors.push(`presets["${name}"]: ignored unknown tool ${JSON.stringify(tool)}`);
      }
    }
    presets[name] = [...new Set(valid)];
  }
  return presets;
}

function normalizeGatingMode(name: string, value: unknown, errors: string[]): GatingModeConfig | null {
  if (!isRecord(value)) {
    errors.push(`gatingModes["${name}"]: expected an object, got ${typeof value}`);
    return null;
  }
  const { trigger, allowTools, allowWriteDir } = value;
  if (typeof trigger !== "string" || trigger.length === 0) {
    errors.push(`gatingModes["${name}"]: missing or empty trigger`);
    return null;
  }
  return {
    trigger,
    allowTools: toStringArray(allowTools, errors, `gatingModes["${name}"].allowTools`),
    allowWriteDir: toStringArray(allowWriteDir, errors, `gatingModes["${name}"].allowWriteDir`),
  };
}

function normalizeGatingModes(value: unknown, errors: string[]): Record<string, GatingModeConfig> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push(`gatingModes: expected an object, got ${typeof value}`);
    return {};
  }
  const modes: Record<string, GatingModeConfig> = {};
  for (const [name, mode] of Object.entries(value)) {
    const normalized = normalizeGatingMode(name, mode, errors);
    if (normalized) modes[name] = normalized;
  }
  return modes;
}

/**
 * Normalize raw configuration data into a fully-typed Config with defaults.
 * Invalid entries are dropped and described in `errors`; this never throws.
 */
export function normalizeConfig(data: unknown): ConfigLoadResult {
  if (!isRecord(data)) {
    return { config: DEFAULT_CONFIG, errors: [`config: expected an object, got ${typeof data}`] };
  }

  const errors: string[] = [];
  const defaultPreset = data.defaultPreset;
  if (
    defaultPreset !== undefined &&
    (typeof defaultPreset !== "string" || !isValidPresetName(defaultPreset))
  ) {
    errors.push(`defaultPreset: must be a string matching [a-z][a-z0-9_-]*`);
  }

  const toolGuide = data.toolGuide;
  if (toolGuide !== undefined && !isRecord(toolGuide)) {
    errors.push(`toolGuide: expected an object, got ${typeof toolGuide}`);
  } else if (
    isRecord(toolGuide) &&
    toolGuide.enabled !== undefined &&
    typeof toolGuide.enabled !== "boolean"
  ) {
    errors.push(`toolGuide.enabled: expected a boolean, got ${typeof toolGuide.enabled}`);
  }

  return {
    config: {
      presets: normalizePresets(data.presets, errors),
      defaultPreset:
        typeof defaultPreset === "string" && isValidPresetName(defaultPreset)
          ? defaultPreset
          : undefined,
      toolGuide:
        isRecord(toolGuide) && typeof toolGuide.enabled === "boolean"
          ? { enabled: toolGuide.enabled }
          : { enabled: true },
      subagentEnvVars: toStringArray(data.subagentEnvVars, errors, "subagentEnvVars"),
      gatingModes: normalizeGatingModes(data.gatingModes, errors),
    },
    errors,
  };
}

/** Load and normalize the config file from an agent directory. */
export async function loadConfigFrom(agentDir: string): Promise<ConfigLoadResult> {
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

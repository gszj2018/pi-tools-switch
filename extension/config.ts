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

export interface GatingModeConfig {
  /** Input prefixes that activate the mode; any one matching the raw input activates it. */
  trigger: string[];
  /** Tools explicitly allowed while the mode is active. */
  allowTools: string[];
  /** Directories where write/edit are allowed while the mode is active. */
  allowWriteDir: string[];
}

export interface Config {
  /** User-defined presets. Names matching built-in presets override them. */
  presets: Record<string, string[]>;
  /** Additional env vars that mark a subagent context. */
  subagentEnvVars: string[];
  /** User-defined gating modes. Names matching built-in modes override them. */
  gatingModes: Record<string, GatingModeConfig>;
  /** Input prefixes that exit the active gating mode; defaults to the normal-mode prompt-template prefix. */
  gatingExitTrigger: string[];
}

/** A normalized config plus the problems found while normalizing it. */
export interface ConfigLoadResult {
  config: Config;
  /** Human-readable descriptions of invalid/ignored entries (empty when clean). */
  errors: string[];
}

/** Recursively freeze an object graph so consumers cannot mutate the config. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Default config: all lists empty; built-ins are merged with user config at load time. */
export const DEFAULT_CONFIG: Config = deepFreeze({
  presets: {},
  subagentEnvVars: [],
  gatingModes: {},
  gatingExitTrigger: [],
});

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

/**
 * Coerce an unknown value to a non-empty trigger-string array. Blank (empty
 * or whitespace-only) prefixes are rejected with an explicit error; non-string
 * entries are dropped and reported through `errors`, prefixed by `field`.
 * Returns the surviving prefixes (possibly empty).
 */
function normalizeTriggerList(value: unknown, errors: string[], field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(
      `${field}: expected an array of non-empty trigger strings (e.g. [\"/plan-mode\"])`,
    );
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${field}: ignored non-string entry ${JSON.stringify(item)}`);
      continue;
    }
    if (item.trim().length === 0) {
      errors.push(`${field}: empty trigger prefix is not allowed`);
      continue;
    }
    result.push(item);
  }
  return result;
}

function normalizeGatingMode(name: string, value: unknown, errors: string[]): GatingModeConfig | null {
  if (!isRecord(value)) {
    errors.push(`gatingModes["${name}"]: expected an object, got ${typeof value}`);
    return null;
  }
  const { trigger, allowTools, allowWriteDir } = value;
  const triggers = normalizeTriggerList(trigger, errors, `gatingModes["${name}"].trigger`);
  if (triggers.length === 0) {
    errors.push(`gatingModes["${name}"]: missing or empty trigger`);
    return null;
  }
  return {
    trigger: triggers,
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

  return {
    config: deepFreeze({
      presets: normalizePresets(data.presets, errors),
      subagentEnvVars: toStringArray(data.subagentEnvVars, errors, "subagentEnvVars"),
      gatingModes: normalizeGatingModes(data.gatingModes, errors),
      gatingExitTrigger: normalizeTriggerList(data.gatingExitTrigger, errors, "gatingExitTrigger"),
    }),
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

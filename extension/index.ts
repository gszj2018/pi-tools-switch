/**
 * Extension entry for pi-tools-switch.
 *
 * Loads the config at startup (falling back to defaults on failure), wires
 * the entry renderer, and injects the getConfig callback into each feature
 * module. Feature modules own their state and status bars independently.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, loadConfigFrom, type Config } from "./config.ts";
import { OUTPUT_ENTRY_TYPE } from "./utils.ts";
import { register as registerBuiltinTools } from "./builtin-tools.ts";
import { register as registerToolGating } from "./tool-gating.ts";
import { register as registerSystemPrompt } from "./system-prompt.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  let config: Config = DEFAULT_CONFIG;
  const problems: string[] = [];
  try {
    const result = await loadConfigFrom(getAgentDir());
    config = result.config;
    problems.push(...result.errors);
  } catch (err) {
    problems.push(`failed to load ${CONFIG_FILE_NAME}: ${(err as Error).message}`);
  }

  // Surface config problems once at session start (file-level failures and
  // invalid entries collected during normalization).
  if (problems.length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(`tools-switch config issues:\n${problems.join("\n")}`, "warning");
    });
  }

  const getConfig = (): Config => config;

  // Renders preset auto-activation notices and finish-tool summaries.
  pi.registerEntryRenderer(OUTPUT_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { lines?: unknown } | undefined;
    const lines = Array.isArray(data?.lines) ? data.lines.map(String) : [];
    const text = lines.length > 0 ? lines.join("\n") : JSON.stringify(entry.data);
    return new Text(theme.fg("accent", text));
  });

  registerBuiltinTools(pi, getConfig);
  registerToolGating(pi, getConfig);
  registerSystemPrompt(pi, getConfig);
}

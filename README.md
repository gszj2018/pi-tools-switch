# pi-tools-switch

English | [简体中文](./README.zh-CN.md)

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension package that manages the availability of eight built-in tools and provides **prefix-caching-friendly tool gating** through prompt-template commands or custom text triggers — including a built-in **Plan Mode** for read-only exploration and planning.

## Features

### 1. Built-in Tool Management

Toggle the eight built-in Pi tools on and off without affecting external tools:

| Letter | Tool         |
|--------|--------------|
| R      | `read`       |
| W      | `write`      |
| E      | `edit`       |
| B      | `bash`       |
| P      | `powershell` |
| F      | `find`       |
| G      | `grep`       |
| L      | `ls`         |

Status bar format: `[RWEBPFGL]`. A disabled tool shows `-` in its slot.

> **Note:** Toggling tool availability changes the active tool set, which may invalidate the LLM's prefix cache. The tool gating feature below is designed to be prefix-caching-friendly and does not affect prefix cache validity.

### 2. Tool Gating Modes

Activate a persistent gating mode by typing a configured trigger prefix. While active, the mode restricts which tools the agent may call. The mode stays active across turns until you explicitly exit it.

Built-in mode:

- **`/plan-mode`** — read-only exploration and planning. Allows writing Markdown plans under `.agents/plans/`.

You can also define custom gating modes with their own triggers, allowed tools, and allowed write directories.

## Installation

Install as a Pi package.

```bash
# From npm
pi install npm:pi-tools-switch

# From this GitHub repository
pi install git:github.com/gszj2018/pi-tools-switch
```

## Usage

### Slash Commands

| Command                         | Description                                                           |
| ------------------------------- | --------------------------------------------------------------------- |
| `/ptsw-status`                  | Show the active status of all built-in and external tools.            |
| `/ptsw-builtin-enable <tool>…`  | Enable one or more built-in tools.                                    |
| `/ptsw-builtin-disable <tool>…` | Disable one or more built-in tools.                                   |
| `/ptsw-preset-list`             | List available presets.                                               |
| `/ptsw-preset-apply <name>`     | Apply a preset.                                                       |
| `/ptsw-mode-list`               | List available gating modes and their triggers/exit triggers.         |
| `/ptsw-mode-show <name>`        | Show details of a specific gating mode.                               |

### Prompt Templates

This extension also ships with two prompt templates. Type `/` followed by the template name in the editor to invoke them:

| Template       | Description                                                                   |
|----------------|-------------------------------------------------------------------------------|
| `/plan-mode`   | Enter plan mode (read-only exploration + write plans under `.agents/plans/`). |
| `/normal-mode` | Exit the active gating mode.                                                  |

### Built-in Presets

| Preset    | Tools enabled                                         | Status bar   |
|-----------|-------------------------------------------------------|--------------|
| `read`    | `read`                                                | `[R-------]` |
| `explore` | `read`, `find`, `grep`, `ls`                          | `[R----FGL]` |
| `default` | `read`, `write`, `edit`, `bash`                       | `[RWEB----]` |
| `full`    | `read`, `write`, `edit`, `bash`, `find`, `grep`, `ls` | `[RWEB-FGL]` |

Presets do **not** include `powershell`. Use `/ptsw-builtin-enable powershell` or define a custom preset if you need it.

### Plan Mode

Plan Mode is the built-in gating mode for read-only exploration and planning.

**How the user enters and exits:**

- Enter: type `/plan-mode`.
- Exit manually: type `/normal-mode`.
- The mode also persists across turns until one of the exit paths above is used.

**What the agent can do in Plan Mode:**

- Use read-only tools: `read`, `find`, `grep`, `ls`.
- Write Markdown plan documents under `.agents/plans/`.
- All other tools, including `bash` and external tools, are blocked.

**Can the agent exit Plan Mode on its own?**

Yes. When the agent decides the planning work is complete, it can call the `exit_mode` tool:

```
exit_mode(mode: "plan", summary: string)
```

- `summary` should be a single concise sentence.
- The user is then asked to **accept and exit**, **accept and stay**, or **refine** the plan.

## Configuration

Create `~/.pi/agent/tools-switch.json` (or `<agentDir>/tools-switch.json` if you have customized `PI_CODING_AGENT_DIR`) to customize presets, subagent detection, and gating modes. The file is loaded once when the extension starts.

```json
{
  "presets": {
    "review": ["read", "grep", "ls"]
  },
  "subagentEnvVars": ["MY_SUBAGENT_FLAG"],
  "gatingModes": {
    "test": {
      "trigger": ["/test-mode"],
      "allowTools": ["read", "bash"],
      "allowWriteDir": ["tests"]
    }
  },
  "gatingExitTrigger": ["/normal-mode"]
}
```

See [`schemas/tools-switch.schema.json`](./schemas/tools-switch.schema.json) for the full JSON Schema.

### Configuration Fields

| Field               | Type       | Description                                                                                                               |
|---------------------|------------|---------------------------------------------------------------------------------------------------------------------------|
| `presets`           | `object`   | User-defined tool presets. Names follow `[a-z][a-z0-9_-]*`. Values are arrays of tool names.                              |
| `subagentEnvVars`   | `string[]` | Extra environment variables that indicate a subagent context, in addition to built-in ones.                               |
| `gatingModes`       | `object`   | User-defined gating modes. Keys are mode names. Same-name modes override built-in modes.                                  |
| `gatingExitTrigger` | `string[]` | Prefixes that exit the active gating mode. Empty or omitted falls back to `"/normal-mode"`. Non-empty fully overrides it. |

### Gating Mode Fields

| Field           | Type       | Description                                                                                 |
|-----------------|------------|---------------------------------------------------------------------------------------------|
| `trigger`       | `string[]` | Input prefixes that activate the mode. Any one matching the raw input activates it.         |
| `allowTools`    | `string[]` | Tools explicitly allowed while the mode is active. These bypass all other restrictions.     |
| `allowWriteDir` | `string[]` | Directories where `write`/`edit` are allowed. Empty or undefined blocks all `write`/`edit`. |

### Tool Interception Order

When a gating mode is active, tool calls are evaluated in this order:

1. `exit_mode` — allowed; parameters are validated at execution time.
2. Read-only tools: `read`, `find`, `grep`, `ls` — allowed.
3. Tools listed in `allowTools` — allowed.
4. `write` / `edit` — allowed only if the target path is strictly inside one of the `allowWriteDir` directories.
5. All other tools, including `bash` and external tools — blocked.

> **Note:** If `write` or `edit` is listed in `allowTools`, it is fully allowed and skips the directory check.

## Status Bar

Two independent status indicators are shown:

- **Tools status**: `[RWEBPFGL]` — shows which built-in tools are currently active.
- **Gating status**: `[M: plan]`, `[M: -]`, or `[M: last => active]` — shows the active gating mode.

Status is refreshed on `session_start`, `turn_start`, `agent_settled`, and whenever tools or modes change.

## Subagent Behavior

When a subagent context is detected (via common environment variables such as `PI_IS_SUBAGENT`, `PI_SUBAGENT_CHILD`, etc.), the extension remains completely silent: it does not register tools, commands, events, or prompts.

> **Note:** This extension detects subagents only when they are implemented as child processes that inherit environment variables. In-process subagent implementations are not detected.

You can extend the list of subagent-detecting environment variables via the `subagentEnvVars` configuration field.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type-check
npm run typecheck
```

To load the extension and prompt templates locally for development without packaging, run pi from the repository root:

```bash
pi -e ./extension/index.ts --prompt-template ./prompts
```

The project is written in TypeScript and uses the Node.js built-in test runner.

## Project Structure

```text
pi-tools-switch/
├── extension/
│   ├── index.ts              # Extension entry point
│   ├── config.ts             # Configuration loading and normalization
│   ├── builtin-tools.ts      # Built-in tool management, presets, status bar
│   ├── tool-gating.ts        # Tool gating engine and exit_mode
│   ├── tool-status.ts        # /ptsw-status command
│   ├── subagent-support.ts   # Subagent detection
│   └── utils*.ts             # Shared helpers
├── prompts/
│   ├── plan-mode.md          # /plan-mode prompt template
│   └── normal-mode.md        # /normal-mode prompt template
├── schemas/
│   └── tools-switch.schema.json
└── tests/                    # Unit and integration tests
```

## License

[MIT](./LICENSE)

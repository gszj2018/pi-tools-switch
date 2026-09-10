# pi-tools-switch

[English](./README.md) | 简体中文

一个 [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 扩展包，用于管理 8 个内置工具的可用性，并通过 prompt template 命令或自定义文本触发器实现**前缀缓存友好的工具门控**，包括内置的**计划模式（Plan Mode）**，用于只读探索与制定计划。

## 功能

### 1. 内置工具管理

独立开关 8 个内置 Pi 工具，不影响外部工具：

| 字母 | 工具         |
| ---- | ------------ |
| R    | `read`       |
| W    | `write`      |
| E    | `edit`       |
| B    | `bash`       |
| P    | `powershell` |
| F    | `find`       |
| G    | `grep`       |
| L    | `ls`         |

状态栏格式：`[RWEBPFGL]`。被禁用的工具显示为 `-`。

> **注意：** 切换工具可用性会改变活动工具集合，可能导致 LLM 的前缀缓存失效。下方的工具门控功能专为前缀缓存友好设计，不会影响前缀缓存的有效性。

### 2. 工具门控模式

输入配置好的触发前缀即可激活持续式门控模式。模式激活后会对智能体（agent）可调用的工具进行限制，并在多轮对话中保持，直到显式退出。

内置模式：

- **`/plan-mode`** — 计划模式，只允许只读探索和向 `.agents/plans/` 写入 Markdown 计划。

你也可以自定义门控模式，指定触发前缀、允许使用的工具以及允许写入的目录。

## 安装

作为 Pi 包安装。

```bash
# 从 npm 安装
pi install npm:pi-tools-switch

# 从本 GitHub 仓库安装
pi install git:github.com/gszj2018/pi-tools-switch
```

## 使用

### Slash 命令

| 命令                            | 说明                                            |
| ------------------------------- | ----------------------------------------------- |
| `/ptsw-status`                  | 显示所有内置及外部工具的当前状态。              |
| `/ptsw-builtin-enable <tool>…`  | 启用一个或多个内置工具。                        |
| `/ptsw-builtin-disable <tool>…` | 禁用一个或多个内置工具。                        |
| `/ptsw-preset-list`             | 列出可用预设。                                  |
| `/ptsw-preset-apply <name>`     | 应用指定预设。                                  |
| `/ptsw-mode-list`               | 列出可用门控模式及其触发/退出前缀。             |
| `/ptsw-mode-show <name>`        | 显示指定门控模式的详情。                        |

### Prompt Template

本扩展还包含两个 prompt template。在编辑器中输入 `/` 后接模板名称即可调用：

| 模板           | 说明                                                    |
|----------------|---------------------------------------------------------|
| `/plan-mode`   | 进入计划模式（只读探索 + 向 `.agents/plans/` 写计划）。 |
| `/normal-mode` | 退出当前门控模式。                                      |

### 内置预设

| 预设      | 启用的工具                                            | 状态栏       |
|-----------|-------------------------------------------------------|--------------|
| `read`    | `read`                                                | `[R-------]` |
| `explore` | `read`, `find`, `grep`, `ls`                          | `[R----FGL]` |
| `default` | `read`, `write`, `edit`, `bash`                       | `[RWEB----]` |
| `full`    | `read`, `write`, `edit`, `bash`, `find`, `grep`, `ls` | `[RWEB-FGL]` |

预设**不包含** `powershell`。如需使用，可通过 `/ptsw-builtin-enable powershell` 或自定义预设启用。

### 计划模式

计划模式是内置的只读探索与制定计划门控模式。

**用户进入与退出方式：**

- 进入：输入 `/plan-mode`。
- 手动退出：输入 `/normal-mode`。
- 该模式会跨轮保持，直到使用上述退出方式之一。

**智能体在计划模式下的限制：**

- 可使用只读工具：`read`、`find`、`grep`、`ls`。
- 可向 `.agents/plans/` 写入 Markdown 计划文档。
- 其它所有工具（包括 `bash` 和外部工具）均被拦截。

**智能体是否可以主动退出计划模式？**

可以。当智能体认为计划工作已完成时，可调用 `exit_mode` 工具：

```
exit_mode(mode: "plan", summary: string)
```

- `summary` 应为一句精简描述。
- 随后用户可选择**接受并退出**、**接受但不退出当前模式**或**继续完善（Refine）**。

## 配置

在 `~/.pi/agent/tools-switch.json`（或自定义了 `PI_CODING_AGENT_DIR` 时的 `<agentDir>/tools-switch.json`）中自定义预设、子智能体（sub-agent）检测和门控模式。扩展启动时加载一次。

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

完整 JSON Schema 见 [`schemas/tools-switch.schema.json`](./schemas/tools-switch.schema.json)。

### 配置字段

| 字段                | 类型       | 说明                                                                              |
|---------------------|------------|-----------------------------------------------------------------------------------|
| `presets`           | `object`   | 用户自定义工具预设。名称需符合 `[a-z][a-z0-9_-]*`，值为工具名数组。               |
| `subagentEnvVars`   | `string[]` | 额外用于检测子智能体上下文的环境变量，追加到内置列表之后。                        |
| `gatingModes`       | `object`   | 用户自定义门控模式。键为模式名；同名模式会覆盖内置模式。                          |
| `gatingExitTrigger` | `string[]` | 退出门控模式的前缀。留空或省略则回退到 `"/normal-mode"`；非空则完全覆盖内置前缀。 |

### 门控模式字段

| 字段            | 类型       | 说明                                                         |
| --------------- | ---------- | ------------------------------------------------------------ |
| `trigger`       | `string[]` | 激活模式的前缀。任一前缀命中原始输入即激活。                 |
| `allowTools`    | `string[]` | 模式激活时显式允许的工具，完全 bypass 其它限制。             |
| `allowWriteDir` | `string[]` | 允许 `write`/`edit` 写入的目录。留空或未定义则禁止所有写入。 |

### 工具拦截顺序

门控模式激活时，工具调用按以下顺序判定：

1. `exit_mode` — 放行；参数在执行阶段校验。
2. 只读工具：`read`、`find`、`grep`、`ls` — 放行。
3. `allowTools` 中列出的工具 — 放行。
4. `write` / `edit` — 仅当目标路径严格位于某个 `allowWriteDir` 目录内时放行。
5. 其它所有工具（包括 `bash` 和外部工具）— 拦截。

> **注意：** 如果 `write` 或 `edit` 出现在 `allowTools` 中，则完全放行，不再进行目录检查。

## 状态栏

显示两个独立的状态指示器：

- **工具状态**：`[RWEBPFGL]` — 显示当前哪些内置工具处于活动状态。
- **门控状态**：`[M: plan]`、`[M: -]` 或 `[M: last => active]` — 显示当前活动门控模式。

状态在 `session_start`、`turn_start`、`agent_settled` 以及工具/模式变化时刷新。

## 子智能体行为

当检测到子智能体上下文（通过 `PI_IS_SUBAGENT`、`PI_SUBAGENT_CHILD` 等常见环境变量）时，扩展保持完全静默：不注册任何工具、命令、事件或提示词。

> **注意：** 当前扩展仅支持检测通过子进程（child-process）实现的子智能体，即通过继承环境变量来标识上下文的情况；不支持检测进程内（in-process）实现的子智能体。

你可以通过 `subagentEnvVars` 配置字段扩展子智能体检测使用的环境变量列表。

## 开发

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 类型检查
npm run typecheck
```

如需在本地开发时直接加载扩展和 prompt template（无需打包），请在仓库根目录运行：

```bash
pi -e ./extension/index.ts --prompt-template ./prompts
```

项目使用 TypeScript 编写，测试采用 Node.js 内置测试运行器。

## 项目结构

```text
pi-tools-switch/
├── extension/
│   ├── index.ts              # 扩展入口
│   ├── config.ts             # 配置加载与归一化
│   ├── builtin-tools.ts      # 内置工具管理、预设、状态栏
│   ├── tool-gating.ts        # 工具门控引擎与 exit_mode
│   ├── tool-status.ts        # /ptsw-status 命令
│   ├── subagent-support.ts   # 子智能体检测
│   └── utils*.ts             # 共享辅助函数
├── prompts/
│   ├── plan-mode.md          # /plan-mode prompt template
│   └── normal-mode.md        # /normal-mode prompt template
├── schemas/
│   └── tools-switch.schema.json
└── tests/                    # 单元测试与集成测试
```

## 开源许可

[MIT](./LICENSE)

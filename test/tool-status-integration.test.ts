/** Integration tests for /ptsw-status with the real status readers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { register as registerBuiltinTools } from "../extension/builtin-tools.ts";
import { DEFAULT_CONFIG, type Config } from "../extension/config.ts";
import { register as registerToolGating } from "../extension/tool-gating.ts";
import { register as registerToolStatus } from "../extension/tool-status.ts";

interface CommandDefinition {
  handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

type EventHandler = (event: { text?: string }, ctx: ExtensionCommandContext) => unknown | Promise<unknown>;

function createMockPi() {
  let activeTools = ["read", "write", "external_tool"];
  const allToolNames = [
    "read",
    "write",
    "edit",
    "bash",
    "powershell",
    "find",
    "grep",
    "ls",
    "external_tool",
  ];
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, EventHandler[]>();
  // noinspection JSUnusedGlobalSymbols
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    getAllTools: () => allToolNames.map((name) => ({ name })),
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(definition: { name: string }) {
      if (!allToolNames.includes(definition.name)) allToolNames.push(definition.name);
    },
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    on(eventName: string, handler: EventHandler) {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    commands,
    async emit(eventName: string, event: { text?: string }, ctx: ExtensionCommandContext) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(event, ctx);
      }
    },
  };
}

function createContext() {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd: "/project",
    hasUI: false,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setStatus: () => {},
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  gatingModes: {
    review: {
      trigger: ["REVIEW:"],
      allowTools: ["bash"],
      allowWriteDir: ["docs"],
    },
  },
};

test("ptsw-status combines registered tool and gating readers without modifying state", async () => {
  const mock = createMockPi();
  const { ctx, notifications } = createContext();
  const readToolStatus = registerBuiltinTools(mock.pi, () => CONFIG);
  const readGatingStatus = registerToolGating(mock.pi, () => CONFIG);
  registerToolStatus(mock.pi, readToolStatus, readGatingStatus);

  await mock.emit("input", { text: "REVIEW:" }, ctx);
  const command = mock.commands.get("ptsw-status");
  assert.ok(command);
  await command.handler("", ctx);

  assert.deepEqual(notifications, [
    {
      message: [
        "[+][ ] read (built-in)",
        "[+][*] write (built-in)",
        "[ ][*] edit (built-in)",
        "[ ][ ] bash (built-in)",
        "[ ][-] powershell (built-in)",
        "[ ][ ] find (built-in)",
        "[ ][ ] grep (built-in)",
        "[ ][ ] ls (built-in)",
        "[+][-] external_tool",
        "[ ][ ] exit_mode",
      ].join("\n"),
      level: "info",
    },
  ]);
  assert.deepEqual(readGatingStatus("bash"), {
    unrestricted: true,
    hasAllowedWriteDir: false,
  });
  assert.deepEqual(readGatingStatus("write"), {
    unrestricted: false,
    hasAllowedWriteDir: true,
  });
  assert.deepEqual(readGatingStatus("external_tool"), {
    unrestricted: false,
    hasAllowedWriteDir: false,
  });

  await command.handler("unexpected", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "Unexpected arguments. Usage: /ptsw-status",
    level: "error",
  });
  assert.deepEqual(readGatingStatus("external_tool"), {
    unrestricted: false,
    hasAllowedWriteDir: false,
  });
});

/**
 * Integration tests for pi-tools-switch Slash commands.
 *
 * Drives the built-in-tools, tool-gating, and tool-status modules through one
 * lightweight mock ExtensionAPI, covering command registration, completion binding,
 * handlers, active-tool state changes, and UI notifications.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { register as registerBuiltinTools } from "../extension/builtin-tools.ts";
import { register as registerToolGating } from "../extension/tool-gating.ts";
import { register as registerToolStatus } from "../extension/tool-status.ts";
import { DEFAULT_CONFIG, type Config } from "../extension/config.ts";

interface CommandDefinition {
  description?: string;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

interface Notification {
  message: string;
  level?: string;
}

type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => unknown | Promise<unknown>;

const TEST_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  presets: {
    custom: ["read", "grep"],
  },
  gatingModes: {
    review: {
      trigger: ["REVIEW:"],
      allowTools: ["bash"],
      allowWriteDir: ["docs"],
    },
  },
  gatingExitTrigger: ["NORMAL:"],
};

const TARGET_COMMANDS = [
  "ptsw-builtin-enable",
  "ptsw-builtin-disable",
  "ptsw-preset-list",
  "ptsw-preset-apply",
  "ptsw-mode-list",
  "ptsw-mode-show",
  "ptsw-status",
] as const;

function createMockCtx() {
  const notifications: Notification[] = [];
  const statuses: { key: string; value: string | undefined }[] = [];
  const ctx = {
    cwd: "C:/project",
    hasUI: false,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
      select: async () => undefined,
      input: async () => undefined,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, statuses };
}

function createMockPi(initialActiveTools: string[] = ["read", "external_tool"]) {
  let activeTools = [...initialActiveTools];
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
  const eventHandlers = new Map<string, EventHandler[]>();

  // noinspection JSUnusedGlobalSymbols
  const pi = {
    on(eventName: string, handler: EventHandler) {
      const handlers = eventHandlers.get(eventName) ?? [];
      handlers.push(handler);
      eventHandlers.set(eventName, handlers);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(definition: { name: string }) {
      if (!allToolNames.includes(definition.name)) allToolNames.push(definition.name);
    },
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    getActiveTools: () => [...activeTools],
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
    getAllTools: () => allToolNames.map((name) => ({ name })),
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    commands,
    activeTools: () => [...activeTools],
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
    async emit(
      eventName: string,
      ctx: ExtensionCommandContext,
      eventData: unknown = {},
    ): Promise<void> {
      for (const handler of eventHandlers.get(eventName) ?? []) {
        await handler(eventData, ctx);
      }
    },
  };
}

async function setup(config: Config = TEST_CONFIG) {
  const mock = createMockPi();
  // Factory-phase registration registers commands and the exit_mode tool, but
  // action methods like setActiveTools only run once the session runtime is
  // initialized.
  const readToolStatus = registerBuiltinTools(mock.pi, () => config);
  const readGatingStatus = registerToolGating(mock.pi, () => config);
  registerToolStatus(mock.pi, readToolStatus, readGatingStatus);
  const context = createMockCtx();

  // Real activation flow: session_start activates exit_mode and refreshes the
  // tool status bar before commands can run.
  await mock.emit("session_start", context.ctx);

  const invoke = async (name: string, args = ""): Promise<void> => {
    const command = mock.commands.get(name);
    assert.ok(command, `expected command to be registered: ${name}`);
    await command.handler(args, context.ctx);
  };

  const emit = async (eventName: string, eventData: unknown = {}): Promise<void> =>
    mock.emit(eventName, context.ctx, eventData);

  return { ...mock, ...context, readToolStatus, invoke, emit };
}

function lastNotification(notifications: Notification[]): Notification {
  const notification = notifications.at(-1);
  assert.ok(notification, "expected a UI notification");
  return notification;
}

test("builtin-tools registration returns a reader tied to the Pi tool state", async () => {
  const mock = await setup();
  assert.equal(typeof mock.readToolStatus, "function");
  const status = mock.readToolStatus();
  assert.deepEqual(status.find((tool) => tool.name === "read"), {
    name: "read",
    enabled: true,
    builtIn: true,
  });
  assert.deepEqual(status.find((tool) => tool.name === "external_tool"), {
    name: "external_tool",
    enabled: true,
    builtIn: false,
  });
  assert.deepEqual(status.find((tool) => tool.name === "exit_mode"), {
    name: "exit_mode",
    enabled: true,
    builtIn: false,
  });
});

test("registers exactly the seven expected commands", async () => {
  const mock = await setup();
  assert.deepEqual([...mock.commands.keys()], TARGET_COMMANDS);
  for (const command of mock.commands.values()) {
    assert.ok(command.description && command.description.length > 0);
  }
});

test("binds completions only to commands that accept completable arguments", async () => {
  const mock = await setup();
  const enable = mock.commands.get("ptsw-builtin-enable")!;
  const disable = mock.commands.get("ptsw-builtin-disable")!;
  assert.equal(enable.getArgumentCompletions, disable.getArgumentCompletions);
  assert.deepEqual(enable.getArgumentCompletions?.("read ")?.[0], {
    value: "read write",
    label: "write",
  });
  assert.deepEqual(disable.getArgumentCompletions?.("read w"), [
    { value: "read write", label: "write" },
  ]);

  const presetValues = mock.commands
    .get("ptsw-preset-apply")!
    .getArgumentCompletions?.("")
    ?.map((item) => item.value);
  assert.ok(presetValues?.includes("explore"));
  assert.ok(presetValues?.includes("custom"));
  assert.deepEqual(mock.commands.get("ptsw-mode-show")!.getArgumentCompletions?.("r"), [
    { value: "review", label: "review" },
  ]);

  for (const name of ["ptsw-status", "ptsw-preset-list", "ptsw-mode-list"]) {
    assert.equal(mock.commands.get(name)!.getArgumentCompletions, undefined);
  }
});

test("argument-free commands reject extra arguments through the shared Pi utility", async () => {
  const mock = await setup();
  for (const name of ["ptsw-status", "ptsw-preset-list", "ptsw-mode-list"]) {
    mock.notifications.length = 0;
    const before = mock.activeTools();
    await mock.invoke(name, "unexpected");
    assert.deepEqual(mock.activeTools(), before);
    assert.deepEqual(lastNotification(mock.notifications), {
      message: `Unexpected arguments. Usage: /${name}`,
      level: "error",
    });
  }
});

test("ptsw-status reports enabled and active-gate state for built-in and external tools", async () => {
  const mock = await setup();
  await mock.emit("input", { text: "REVIEW:" });
  await mock.invoke("ptsw-status");
  const notification = lastNotification(mock.notifications);
  assert.equal(notification.level, "info");
  assert.match(notification.message, /\[\+]\[ ] read \(built-in\)/);
  assert.match(notification.message, /\[ ]\[\*] write \(built-in\)/);
  assert.match(notification.message, /\[ ]\[ ] bash \(built-in\)/);
  assert.match(notification.message, /\[ ]\[-] powershell \(built-in\)/);
  assert.match(notification.message, /\[\+]\[-] external_tool/);
  assert.match(notification.message, /\[\+]\[ ] exit_mode/);
});

test("builtin enable and disable support multiple tools and preserve external tools", async () => {
  // After session_start read, external_tool, and exit_mode are active. The
  // test enables write/edit/bash/powershell, then disables powershell plus
  // read-only helpers while preserving external tools and the enabled tools.
  const mock = await setup();
  await mock.invoke("ptsw-builtin-enable", "write edit bash powershell");
  assert.deepEqual(mock.activeTools(), [
    "read",
    "external_tool",
    "exit_mode",
    "write",
    "edit",
    "bash",
    "powershell",
  ]);
  assert.match(lastNotification(mock.notifications).message, /Enabled write, edit, bash, powershell/);

  await mock.invoke("ptsw-builtin-disable", "read powershell find grep ls");
  assert.deepEqual(mock.activeTools(), [
    "external_tool",
    "exit_mode",
    "write",
    "edit",
    "bash",
  ]);
  assert.match(lastNotification(mock.notifications).message, /Disabled read, powershell, find, grep, ls/);
  assert.ok(mock.statuses.some(({ key }) => key === "pi-tools-switch-status"));
});

test("builtin enable and disable reject missing or invalid tools atomically", async () => {
  const mock = await setup();
  const initial = mock.activeTools();

  await mock.invoke("ptsw-builtin-enable", "");
  assert.deepEqual(mock.activeTools(), initial);
  assert.match(lastNotification(mock.notifications).message, /Missing tool name/);
  assert.match(lastNotification(mock.notifications).message, /ptsw-builtin-enable/);

  await mock.invoke("ptsw-builtin-enable", "write invalid grep");
  assert.deepEqual(mock.activeTools(), initial);
  assert.match(lastNotification(mock.notifications).message, /Invalid tool\(s\): invalid/);

  await mock.invoke("ptsw-builtin-disable", "");
  assert.deepEqual(mock.activeTools(), initial);
  assert.match(lastNotification(mock.notifications).message, /ptsw-builtin-disable/);
});

test("preset list and apply preserve listing, validation, and application behavior", async () => {
  const mock = await setup();
  await mock.invoke("ptsw-preset-list");
  const list = lastNotification(mock.notifications);
  assert.equal(list.level, "info");
  assert.match(list.message, /\[R-------] read/);
  assert.match(list.message, /\[R-----G-] custom/);

  mock.setActiveTools(["bash", "powershell", "external_tool"]);
  await mock.invoke("ptsw-preset-apply", "custom");
  assert.deepEqual(mock.activeTools(), ["external_tool", "read", "grep"]);
  assert.match(lastNotification(mock.notifications).message, /Preset "custom" applied/);
  assert.deepEqual(mock.statuses.at(-1), {
    key: "pi-tools-switch-status",
    value: "[R-----G-]",
  });

  const applied = mock.activeTools();
  await mock.invoke("ptsw-preset-apply", "");
  assert.deepEqual(mock.activeTools(), applied);
  assert.match(lastNotification(mock.notifications).message, /Missing preset name/);

  await mock.invoke("ptsw-preset-apply", "Bad Name");
  assert.deepEqual(mock.activeTools(), applied);
  assert.match(lastNotification(mock.notifications).message, /Invalid preset name/);

  await mock.invoke("ptsw-preset-apply", "missing");
  assert.deepEqual(mock.activeTools(), applied);
  assert.match(lastNotification(mock.notifications).message, /Unknown preset: missing/);
});

test("preset apply does not mutate config or reset on a later session start", async () => {
  const config: Config = {
    ...TEST_CONFIG,
    presets: { ...TEST_CONFIG.presets },
  };
  const mock = await setup(config);

  await mock.invoke("ptsw-preset-apply", "custom");
  assert.deepEqual(config.presets, { custom: ["read", "grep"] });

  await mock.emit("session_start");
  assert.deepEqual(mock.activeTools(), ["external_tool", "exit_mode", "read", "grep"]);
  assert.deepEqual(
    mock.statuses.filter(({ key }) => key === "pi-tools-switch-status").at(-1),
    {
      key: "pi-tools-switch-status",
      value: "[R-----G-]",
    },
  );
});

test("mode list and show preserve summaries, details, and validation", async () => {
  const mock = await setup();
  await mock.invoke("ptsw-mode-list");
  const list = lastNotification(mock.notifications);
  assert.equal(list.level, "info");
  assert.equal(
    list.message,
    [
      "plan trigger: /plan-mode",
      "review trigger: REVIEW:",
      "exit trigger: NORMAL:",
    ].join("\n"),
  );
  assert.ok(!list.message.includes("allow:"));
  assert.ok(!list.message.includes("write:"));
  assert.ok(!list.message.includes("allowTools"));
  assert.ok(!list.message.includes("allowWriteDir"));

  await mock.invoke("ptsw-mode-show", "review");
  const details = lastNotification(mock.notifications);
  assert.equal(details.level, "info");
  assert.match(details.message, /Mode: review/);
  assert.match(details.message, /allowTools: bash/);
  assert.match(details.message, /allowWriteDir: docs/);

  await mock.invoke("ptsw-mode-show", "");
  assert.match(lastNotification(mock.notifications).message, /Missing mode name/);
  assert.match(lastNotification(mock.notifications).message, /ptsw-mode-show/);

  await mock.invoke("ptsw-mode-show", "missing");
  assert.deepEqual(lastNotification(mock.notifications), {
    message: "Unknown mode: missing",
    level: "error",
  });
});

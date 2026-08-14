/**
 * Integration tests for pi-tools-switch Slash commands.
 *
 * Drives the built-in-tools and tool-gating modules through one lightweight
 * mock ExtensionAPI, covering command registration, completion binding,
 * handlers, active-tool state changes, and UI notifications.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { register as registerBuiltinTools } from "../extension/builtin-tools.ts";
import { register as registerToolGating } from "../extension/tool-gating.ts";
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
  defaultPreset: "explore",
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
  "ptsw-builtin-status",
  "ptsw-builtin-enable",
  "ptsw-builtin-disable",
  "ptsw-builtin-reset",
  "ptsw-preset-list",
  "ptsw-preset-apply",
  "ptsw-mode-list",
  "ptsw-mode-show",
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
    async emit(eventName: string, ctx: ExtensionCommandContext): Promise<void> {
      for (const handler of eventHandlers.get(eventName) ?? []) {
        await handler({}, ctx);
      }
    },
  };
}

function setup(config: Config = TEST_CONFIG) {
  const mock = createMockPi();
  registerBuiltinTools(mock.pi, () => config);
  registerToolGating(mock.pi, () => config);
  const context = createMockCtx();

  const invoke = async (name: string, args = ""): Promise<void> => {
    const command = mock.commands.get(name);
    assert.ok(command, `expected command to be registered: ${name}`);
    await command.handler(args, context.ctx);
  };

  const emit = async (eventName: string): Promise<void> => mock.emit(eventName, context.ctx);

  return { ...mock, ...context, invoke, emit };
}

function lastNotification(notifications: Notification[]): Notification {
  const notification = notifications.at(-1);
  assert.ok(notification, "expected a UI notification");
  return notification;
}

test("registers exactly the eight expected commands", () => {
  const mock = setup();
  assert.deepEqual([...mock.commands.keys()], TARGET_COMMANDS);
  for (const command of mock.commands.values()) {
    assert.ok(command.description && command.description.length > 0);
  }
});

test("binds completions only to commands that accept completable arguments", () => {
  const mock = setup();
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

  for (const name of [
    "ptsw-builtin-status",
    "ptsw-builtin-reset",
    "ptsw-preset-list",
    "ptsw-mode-list",
  ]) {
    assert.equal(mock.commands.get(name)!.getArgumentCompletions, undefined);
  }
});

test("argument-free commands reject extra arguments through the shared Pi utility", async () => {
  const mock = setup();
  for (const name of [
    "ptsw-builtin-status",
    "ptsw-builtin-reset",
    "ptsw-preset-list",
    "ptsw-mode-list",
  ]) {
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

test("ptsw-builtin-status reports built-in and external tool state", async () => {
  const mock = setup();
  await mock.invoke("ptsw-builtin-status");
  const notification = lastNotification(mock.notifications);
  assert.equal(notification.level, "info");
  assert.match(notification.message, /\[\+] read \(built-in\)/);
  assert.match(notification.message, /\[ ] write \(built-in\)/);
  assert.match(notification.message, /\[\+] external_tool/);
});

test("builtin enable and disable support multiple tools and preserve external tools", async () => {
  const mock = setup();
  await mock.invoke("ptsw-builtin-enable", "write grep");
  assert.deepEqual(mock.activeTools(), ["read", "external_tool", "exit_mode", "write", "grep"]);
  assert.match(lastNotification(mock.notifications).message, /Enabled write, grep/);

  await mock.invoke("ptsw-builtin-disable", "read grep");
  assert.deepEqual(mock.activeTools(), ["external_tool", "exit_mode", "write"]);
  assert.match(lastNotification(mock.notifications).message, /Disabled read, grep/);
  assert.ok(mock.statuses.some(({ key }) => key === "pi-tools-switch-status"));
});

test("builtin enable and disable reject missing or invalid tools atomically", async () => {
  const mock = setup();
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

test("ptsw-builtin-reset restores the effective default preset", async () => {
  const mock = setup();
  mock.setActiveTools(["write", "external_tool"]);
  await mock.invoke("ptsw-builtin-reset");
  assert.deepEqual(mock.activeTools(), ["external_tool", "read", "find", "grep", "ls"]);
  assert.match(lastNotification(mock.notifications).message, /Restored preset "explore"/);
});

test("ptsw-builtin-reset does not mutate tools without an effective default", async () => {
  const config: Config = { ...TEST_CONFIG, defaultPreset: "missing" };
  const mock = setup(config);
  const initial = mock.activeTools();
  await mock.invoke("ptsw-builtin-reset");
  assert.deepEqual(mock.activeTools(), initial);
  assert.deepEqual(lastNotification(mock.notifications), {
    message: "No default preset configured",
    level: "warning",
  });
});

test("preset list and apply preserve listing, validation, and application behavior", async () => {
  const mock = setup();
  await mock.invoke("ptsw-preset-list");
  const list = lastNotification(mock.notifications);
  assert.equal(list.level, "info");
  assert.match(list.message, /\[R------] read/);
  assert.match(list.message, /\[R----G-] custom/);

  mock.setActiveTools(["bash", "external_tool"]);
  await mock.invoke("ptsw-preset-apply", "custom");
  assert.deepEqual(mock.activeTools(), ["external_tool", "read", "grep"]);
  assert.match(lastNotification(mock.notifications).message, /Preset "custom" applied/);
  assert.deepEqual(mock.statuses.at(-1), {
    key: "pi-tools-switch-status",
    value: "[R----G-] [D: custom]",
  });

  mock.setActiveTools(["bash", "external_tool"]);
  await mock.invoke("ptsw-builtin-reset");
  assert.deepEqual(mock.activeTools(), ["external_tool", "read", "grep"]);
  assert.match(lastNotification(mock.notifications).message, /Restored preset "custom"/);

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

  mock.setActiveTools(["bash", "external_tool"]);
  await mock.invoke("ptsw-builtin-reset");
  assert.deepEqual(mock.activeTools(), ["external_tool", "read", "grep"]);
  assert.match(lastNotification(mock.notifications).message, /Restored preset "custom"/);
});

test("preset apply remains session-scoped and does not mutate config", async () => {
  const config: Config = {
    ...TEST_CONFIG,
    presets: { ...TEST_CONFIG.presets },
  };
  const mock = setup(config);

  await mock.invoke("ptsw-preset-apply", "custom");
  assert.equal(config.defaultPreset, "explore");
  assert.deepEqual(config.presets, { custom: ["read", "grep"] });

  await mock.emit("session_start");
  assert.deepEqual(mock.activeTools(), ["external_tool", "exit_mode", "read", "find", "grep", "ls"]);
  assert.deepEqual(
    mock.statuses.filter(({ key }) => key === "pi-tools-switch-status").at(-1),
    {
      key: "pi-tools-switch-status",
      value: "[R---FGL] [D: explore]",
    },
  );
});

test("mode list and show preserve summaries, details, and validation", async () => {
  const mock = setup();
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

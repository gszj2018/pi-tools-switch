/**
 * Integration tests for the gating event flow (extension/tool-gating.ts).
 *
 * Drives the module through a lightweight mock of the pi extension API and
 * mock extension contexts, covering the cross-event behavior that pure unit
 * tests cannot reach: mode-state message injection timing and dedup, the
 * steering guard flag, stable exit_mode availability, tool_call gating, and
 * exit_mode execute responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_MODE_PROMPT_GUIDELINES,
  EXIT_MODE_PROMPT_SNIPPET,
  EXIT_MODE_TOOL_NAME,
  formatModeTriggerEntry,
  register,
} from "../extension/tool-gating.ts";
import { DEFAULT_CONFIG, type Config } from "../extension/config.ts";
import {
  MODE_MESSAGE_CUSTOM_TYPE,
  MODE_TRIGGER_CUSTOM_TYPE,
} from "../extension/tool-gating-replay.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CWD = "C:/proj";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockUi {
  setStatus: () => void;
  notify: (text: string, level?: string) => void;
  select: () => Promise<string>;
  input: () => Promise<string>;
}

/** A minimal extension context with a configurable UI and active branch. */
function createMockCtx(
  overrides: {
    cwd?: string;
    hasUI?: boolean;
    ui?: Partial<MockUi>;
    branch?: unknown[];
    branchError?: Error;
  } = {},
): ExtensionContext {
  const baseUi: MockUi = {
    setStatus: () => {},
    notify: () => {},
    select: async () => "Accept",
    input: async () => "",
  };
  return {
    cwd: overrides.cwd ?? CWD,
    hasUI: overrides.hasUI ?? false,
    ui: { ...baseUi, ...(overrides.ui ?? {}) },
    sessionManager: {
      getBranch: () => {
        if (overrides.branchError) throw overrides.branchError;
        return (overrides.branch ?? []) as never;
      },
    },
  } as unknown as ExtensionContext;
}

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface MockPi {
  on: (event: string, handler: Handler) => void;
  emit: (event: string, eventData: unknown, ctx: unknown) => Promise<unknown>;
  getActiveTools: () => string[];
  setActiveTools: (tools: string[]) => void;
  registerTool: (def: RegisteredTool) => void;
  registerCommand: () => void;
  appendEntry: (customType: string, data?: unknown) => void;
  registerEntryRenderer: (customType: string, renderer: (entry: { data?: unknown }) => unknown) => void;
}

/** A mock pi capturing event handlers and tool registrations. */
function createMockPi() {
  const handlers: { event: string; handler: Handler }[] = [];
  let activeTools: string[] = [];
  const tools: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const toolDefinitions: Record<string, RegisteredTool> = {};
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const entryRenderers: Record<string, (entry: { data?: unknown }) => unknown> = {};
  const pi = {
    on(event: string, handler: Handler) {
      handlers.push({ event, handler });
    },
    async emit(event: string, eventData: unknown, ctx: unknown) {
      let result: unknown;
      for (const h of handlers) {
        if (h.event === event) result = await h.handler(eventData, ctx);
      }
      return result;
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (next: string[]) => {
      activeTools = [...next];
    },
    registerTool(def: RegisteredTool) {
      tools[def.name] = def.execute;
      toolDefinitions[def.name] = def;
    },
    registerCommand: () => {},
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    registerEntryRenderer(customType: string, renderer: (entry: { data?: unknown }) => unknown) {
      entryRenderers[customType] = renderer;
    },
  } as MockPi;

  return {
    pi: pi as unknown as ExtensionAPI,
    /** Fire an event with a fresh default context unless one is given. */
    emit: (event: string, data: unknown = {}, ctx: unknown = createMockCtx()) =>
      pi.emit(event, data, ctx),
    activeTools: (): string[] => activeTools,
    tools,
    toolDefinitions,
    appendedEntries,
    entryRenderers,
  };
}

/** Register the gating module against a fresh mock; returns the mock handles. */
function setup(config: Config = DEFAULT_CONFIG) {
  const mock = createMockPi();
  register(mock.pi, () => config);
  return mock;
}

/** Extract the injected mode-state message from a before_agent_start result. */
interface InjectedMessage {
  message: {
    customType: string;
    content: string;
    display: boolean;
    details?: { modeName: string | null };
  };
}

function injected(result: unknown): InjectedMessage["message"] | undefined {
  if (result && typeof result === "object" && "message" in result) {
    return (result as InjectedMessage).message;
  }
  return undefined;
}

/** Extract a tool_call block result ({ block: true, reason }) if present. */
interface BlockResult {
  block: boolean;
  reason?: string;
}

function blocked(result: unknown): BlockResult | undefined {
  if (result && typeof result === "object" && "block" in result) {
    return result as BlockResult;
  }
  return undefined;
}

interface ExitModeToolResult {
  terminate?: true;
  content?: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
}

const EXPLORE_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  gatingModes: {
    explore: { trigger: ["/skill:explore"], allowTools: [], allowWriteDir: [] },
  },
};

// --- A. Stable exit_mode metadata and mode-state injection ---------------

test("registers one stable exit_mode with fixed prompt metadata and schema", async () => {
  const { emit, activeTools, toolDefinitions } = setup(EXPLORE_CONFIG);
  // exit_mode becomes active at session_start (the runtime is not ready
  // during factory load), so drive the real lifecycle before asserting.
  await emit("session_start");
  assert.deepEqual(Object.keys(toolDefinitions), [EXIT_MODE_TOOL_NAME]);
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);

  const tool = toolDefinitions[EXIT_MODE_TOOL_NAME];
  assert.equal(tool.label, "Complete Current Gating Mode");
  assert.match(tool.description, /concise one-sentence completion summary/);
  assert.match(tool.description, /full deliverable separately before calling/);
  assert.equal(tool.promptSnippet, EXIT_MODE_PROMPT_SNIPPET);
  assert.deepEqual(tool.promptGuidelines, EXIT_MODE_PROMPT_GUIDELINES);
  assert.ok((tool.promptGuidelines?.length ?? 0) <= 3);
  assert.ok(tool.promptGuidelines?.every((guideline) => guideline.includes(EXIT_MODE_TOOL_NAME)));
  assert.ok(tool.promptGuidelines?.every((guideline) => !/subagent/i.test(guideline)));
  assert.equal(tool.executionMode, "sequential");

  const schema = tool.parameters as {
    required?: string[];
    properties?: Record<string, { description?: string }>;
  };
  assert.deepEqual(schema.required, ["mode", "summary"]);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["mode", "summary"]);
  assert.match(schema.properties?.summary?.description ?? "", /one-sentence summary/);
  assert.match(schema.properties?.summary?.description ?? "", /full deliverable separately/);
});

test("first turn without a trigger skips injection when branch replay reports no mode", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
  assert.equal(await emit("before_agent_start"), undefined);
});

test("session_start replays a prior mode and injects the current no-mode state", async () => {
  const { emit } = setup();
  const ctx = createMockCtx({
    branch: [
      {
        type: "custom_message",
        customType: MODE_MESSAGE_CUSTOM_TYPE,
        details: { modeName: "plan" },
      },
    ],
  });
  await emit("session_start", {}, ctx);
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a changed state to be injected");
  assert.match(msg!.content, /not currently in any gating mode/);
  assert.deepEqual(msg!.details, { modeName: null });
});

test("session_start reports a replay failure and forces a mode-state injection", async () => {
  const { emit } = setup();
  const notifications: string[] = [];
  const ctx = createMockCtx({
    branchError: new Error("session unavailable"),
    ui: { notify: (text: string) => notifications.push(text) },
  });
  await emit("session_start", {}, ctx);
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "unknown replay state must be reported again");
  assert.deepEqual(msg!.details, { modeName: null });
  assert.deepEqual(notifications, [
    "tools-switch: failed to restore gating state: session unavailable",
    "tools-switch: failed to restore gating mode: session unavailable",
  ]);
});

test("session_tree replays the newly active branch before the next injection", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  assert.ok(injected(await emit("before_agent_start")));
  await emit("agent_settled");
  await emit(
    "session_tree",
    {},
    createMockCtx({
      branch: [
        { type: "custom", customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: "plan" } },
        {
          type: "custom_message",
          customType: MODE_MESSAGE_CUSTOM_TYPE,
          details: { modeName: null },
        },
      ],
    }),
  );
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "the active plan mode differs from the restored no-mode state");
  assert.deepEqual(msg!.details, { modeName: "plan" });
});

test("entering a mode injects the mode-state message without changing active tools", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  const before = activeTools();
  await emit("input", { text: "/plan-mode draw a plan" });
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a mode-state message when entering the mode");
  assert.equal(msg!.customType, MODE_MESSAGE_CUSTOM_TYPE);
  assert.match(msg!.content, /You are in plan mode/);
  assert.match(msg!.content, /Allowed tools: exit_mode/);
  assert.deepEqual(activeTools(), before);
});

test("a repeated trigger does not re-inject the same mode message", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode first" });
  assert.ok(injected(await emit("before_agent_start")));
  await emit("agent_settled");
  await emit("input", { text: "/plan-mode again" });
  assert.equal(await emit("before_agent_start"), undefined, "no message when the mode is unchanged");
});

test("the mode persists across turns: a plain turn stays gated without re-injection", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  await emit("input", { text: "plain question" });
  assert.equal(
    await emit("before_agent_start"),
    undefined,
    "no new message when the mode is unchanged",
  );
  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }));
  assert.ok(gated, "bash should still be gated in the next turn");
});

test("switching modes injects the new state without changing active tools", async () => {
  const { emit, activeTools } = setup(EXPLORE_CONFIG);
  await emit("session_start");
  const before = activeTools();
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  await emit("input", { text: "/skill:explore" });
  assert.deepEqual(activeTools(), before);
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a message when switching modes");
  assert.match(msg!.content, /You are in explore mode/);
});

test("exit_mode stays active after agent_settled while the mode persists", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
});

test("the exit trigger exits the mode, keeps exit_mode active, and ungates tools", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  await emit("input", { text: "/normal-mode" });
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a no-mode message after exiting");
  assert.match(msg!.content, /not currently in any gating mode/);
  const allowed = await emit("tool_call", { toolName: "bash", input: { command: "x" } });
  assert.equal(allowed, undefined, "tools are ungated after exiting");
});

test("the exit trigger with no active mode is harmless", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/normal-mode" });
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
  assert.equal(await emit("before_agent_start"), undefined);
});

test("a non-empty configured exit trigger fully overrides the built-in prefix", async () => {
  const { emit, activeTools } = setup({ ...DEFAULT_CONFIG, gatingExitTrigger: ["NORMAL:"] });
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  // The built-in prefix no longer exits the mode: bash stays gated.
  await emit("input", { text: "/normal-mode" });
  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }));
  assert.ok(gated, "bash should remain gated after the built-in prefix");
  assert.match(gated!.reason ?? "", /In plan mode/);
  // The configured prefix exits the mode and ungates tools.
  await emit("input", { text: "NORMAL:" });
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a no-mode message after the configured trigger");
  assert.match(msg!.content, /not currently in any gating mode/);
  const allowed = await emit("tool_call", { toolName: "bash", input: { command: "x" } });
  assert.equal(allowed, undefined, "tools are ungated after the configured exit");
});

// --- B. Steering guard ------------------------------------------------------

test("steering input during a run cannot change the mode and notifies an error", async () => {
  const { emit, activeTools } = setup(EXPLORE_CONFIG);
  const notified: string[] = [];
  const ctx = createMockCtx({ ui: { notify: (text: string) => notified.push(text) } });
  await emit("session_start");
  // Turn 1: enter plan mode.
  await emit("input", { text: "/plan-mode" });
  assert.ok(injected(await emit("before_agent_start")));
  // A mode trigger arrives mid-run (guard raised): the input is consumed so it
  // never reaches the agent, the mode stays unchanged, and an error notice is
  // shown.
  const blockedModeInput = await emit("input", { text: "/skill:explore" }, ctx);
  assert.deepEqual(blockedModeInput, { action: "handled" }, "input during the guard is consumed");
  assert.equal(notified.length, 1, "a mode trigger during the guard should notify an error");
  assert.match(notified[0], /Cannot switch the gating mode/);
  // An exit trigger during the run is rejected the same way.
  const blockedExitInput = await emit("input", { text: "/normal-mode" }, ctx);
  assert.deepEqual(blockedExitInput, { action: "handled" });
  assert.equal(notified.length, 2, "an exit trigger during the guard should also notify");
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME], "the mode switch attempt changes no tools");
  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }));
  assert.ok(gated, "bash should still be gated by plan mode");
  assert.match(gated!.reason ?? "", /In plan mode/);
  // After settle the guard is cleared: a new trigger can activate explore.
  await emit("agent_settled");
  await emit("input", { text: "/skill:explore" });
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected explore to activate after settle");
  assert.match(msg!.content, /You are in explore mode/);
});

test("ordinary steering input during a run passes through without notify", async () => {
  const { emit } = setup(EXPLORE_CONFIG);
  const notified: string[] = [];
  const ctx = createMockCtx({ ui: { notify: (text: string) => notified.push(text) } });
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  const result = await emit("input", { text: "please continue" }, ctx);
  assert.equal(result, undefined, "ordinary input during the guard is not blocked");
  assert.deepEqual(notified, [], "plain input during the guard stays quiet");
});

// --- C. tool_call gating while a mode is active ----------------------------

test("tool calls are gated while the mode is active", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  for (const toolName of ["bash", "powershell"]) {
    const gated = blocked(await emit("tool_call", { toolName, input: { command: "echo x" } }));
    assert.ok(gated, `${toolName} should be blocked in plan mode`);
    assert.match(gated!.reason ?? "", /In plan mode/);
  }
  const readAllowed = await emit("tool_call", { toolName: "read", input: {} });
  assert.equal(readAllowed, undefined, "read should pass through");
  const exitAllowed = await emit("tool_call", {
    toolName: EXIT_MODE_TOOL_NAME,
    input: { mode: "plan", summary: "done" },
  });
  assert.equal(exitAllowed, undefined, "exit_mode should pass through the gate");
});

test("tools explicitly included in allowTools are allowed", async () => {
  const { emit } = setup({
    ...DEFAULT_CONFIG,
    gatingModes: {
      shell: { trigger: ["SHELL:"], allowTools: ["bash", "powershell"], allowWriteDir: [] },
    },
  });
  await emit("session_start");
  await emit("input", { text: "SHELL:" });
  await emit("before_agent_start");
  for (const toolName of ["bash", "powershell"]) {
    const allowed = await emit("tool_call", { toolName, input: { command: "echo x" } });
    assert.equal(allowed, undefined, `${toolName} should pass when explicitly allowed`);
  }
});

test("write allowWriteDir gating honors Pi @ paths and strict directory descendants", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  const inDir = await emit("tool_call", {
    toolName: "write",
    input: { path: "C:/proj/.agents/plans/plan.md", content: "# Plan\n" },
  });
  assert.equal(inDir, undefined, "write inside allowWriteDir should pass");
  const atPrefixedPath = await emit("tool_call", {
    toolName: "write",
    input: { path: "@.agents/plans/plan.md", content: "# Plan\n" },
  });
  assert.equal(atPrefixedPath, undefined, "write should strip one leading @ before gating");
  const directoryPath = blocked(
    await emit("tool_call", {
      toolName: "write",
      input: { path: "C:/proj/.agents/plans", content: "# Plan\n" },
    }),
  );
  assert.ok(directoryPath, "write path equal to allowWriteDir should be blocked");
  const outDir = blocked(
    await emit("tool_call", {
      toolName: "write",
      input: { path: "C:/proj/src/file.ts", content: "# Plan\n" },
    }),
  );
  assert.ok(outDir, "write outside allowWriteDir should be blocked");
});

test("edit allowWriteDir gating honors Pi @ paths and strict directory descendants", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  const inDir = await emit("tool_call", {
    toolName: "edit",
    input: {
      path: "C:/proj/.agents/plans/plan.md",
      edits: [{ oldText: "old", newText: "new" }],
    },
  });
  assert.equal(inDir, undefined, "edit inside allowWriteDir should pass");
  const atPrefixedPath = await emit("tool_call", {
    toolName: "edit",
    input: {
      path: "@.agents/plans/plan.md",
      edits: [{ oldText: "old", newText: "new" }],
    },
  });
  assert.equal(atPrefixedPath, undefined, "edit should strip one leading @ before gating");
  const directoryPath = blocked(
    await emit("tool_call", {
      toolName: "edit",
      input: { path: "C:/proj/.agents/plans", edits: [{ oldText: "old", newText: "new" }] },
    }),
  );
  assert.ok(directoryPath, "edit path equal to allowWriteDir should be blocked");
  const outDir = blocked(
    await emit("tool_call", {
      toolName: "edit",
      input: { path: "C:/proj/src/file.ts", edits: [{ oldText: "old", newText: "new" }] },
    }),
  );
  assert.ok(outDir, "edit outside allowWriteDir should be blocked");
});

// --- D. exit_mode validation and execute responses --------------------------

test("exit_mode fails without an active mode and has no UI side effects", async () => {
  const { emit, tools, activeTools } = setup();
  const notified: string[] = [];
  let selectCalls = 0;
  await emit("session_start");
  await assert.rejects(
    tools[EXIT_MODE_TOOL_NAME](
      "id",
      { mode: "plan", summary: "done" },
      undefined,
      undefined,
      createMockCtx({
        hasUI: true,
        ui: {
          notify: (text: string) => notified.push(text),
          select: async () => {
            selectCalls += 1;
            return "Accept and exit mode";
          },
        },
      }),
    ),
    /no gating mode is currently active/,
  );
  assert.deepEqual(notified, []);
  assert.equal(selectCalls, 0);
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
});

test("exit_mode rejects a mismatched mode without changing the active mode", async () => {
  const { emit, tools, activeTools } = setup(EXPLORE_CONFIG);
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await assert.rejects(
    tools[EXIT_MODE_TOOL_NAME](
      "id",
      { mode: "explore", summary: "done" },
      undefined,
      undefined,
      createMockCtx(),
    ),
    /requested mode "explore" does not match the active mode "plan"/,
  );
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }));
  assert.match(gated?.reason ?? "", /In plan mode/);
});

test("exit_mode non-interactive Accept-and-exit terminates and closes the mode", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  const result = (await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "Plan done" },
    undefined,
    undefined,
    createMockCtx(),
  )) as ExitModeToolResult;
  assert.equal(result.terminate, true);
  assert.match(result.content?.[0]?.text ?? "", /The user has accepted\. Exiting plan mode now\./);
  assert.deepEqual(result.details, { summary: "Plan done" });
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
  const msg = injected(await emit("before_agent_start"));
  assert.match(msg?.content ?? "", /not currently in any gating mode/);
});

test("exit_mode interactive Accept-and-exit terminates and closes the mode", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  const result = (await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "done" },
    undefined,
    undefined,
    createMockCtx({ hasUI: true, ui: { select: async () => "Accept and exit mode" } }),
  )) as ExitModeToolResult;
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { summary: "done" });
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
});

test("exit_mode Accept-and-stay terminates but keeps the mode active", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  const result = (await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "done" },
    undefined,
    undefined,
    createMockCtx({ hasUI: true, ui: { select: async () => "Accept and stay in mode" } }),
  )) as ExitModeToolResult;
  assert.equal(result.terminate, true);
  assert.match(result.content?.[0]?.text ?? "", /still in plan mode/);
  assert.deepEqual(result.details, { summary: "done" });
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
  await emit("agent_settled");
  assert.equal(await emit("before_agent_start"), undefined, "no re-injection for an unchanged mode");
});

test("exit_mode Refine keeps the turn running with a refinement hint", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("before_agent_start");
  const result = (await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "done" },
    undefined,
    undefined,
    createMockCtx({
      hasUI: true,
      ui: { select: async () => "Refine", input: async () => "add tests" },
    }),
  )) as ExitModeToolResult;
  assert.equal(result.terminate, undefined, "refine must not terminate the turn");
  assert.match(result.content?.[0]?.text ?? "", /Refinement hint: add tests/);
  assert.deepEqual(result.details, { summary: "done" });
  assert.deepEqual(activeTools(), [EXIT_MODE_TOOL_NAME]);
});

test("exit_mode Refine omits the hint when the refinement input is blank", async () => {
  const { emit, tools } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  const result = (await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "done" },
    undefined,
    undefined,
    createMockCtx({
      hasUI: true,
      ui: { select: async () => "Refine", input: async () => "   " },
    }),
  )) as ExitModeToolResult;
  assert.equal(result.terminate, undefined);
  assert.doesNotMatch(result.content?.[0]?.text ?? "", /Refinement hint/);
  assert.deepEqual(result.details, { summary: "done" });
});

// --- E. Persisted mode triggers and replay ---------------------------------

test("records input mode transitions without recording no-op triggers", async () => {
  const { emit, appendedEntries } = setup(EXPLORE_CONFIG);
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit("input", { text: "/plan-mode again" });
  await emit("input", { text: "/skill:explore" });
  await emit("input", { text: "/normal-mode" });

  assert.deepEqual(appendedEntries, [
    { customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: "plan" } },
    { customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: "explore" } },
    { customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: null } },
  ]);
});

test("exit_mode records only an accepted exit, not stay or refine", async () => {
  const { emit, tools, appendedEntries } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "stay" },
    undefined,
    undefined,
    createMockCtx({ hasUI: true, ui: { select: async () => "Accept and stay in mode" } }),
  );
  await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "refine" },
    undefined,
    undefined,
    createMockCtx({ hasUI: true, ui: { select: async () => "Refine", input: async () => "more" } }),
  );
  await tools[EXIT_MODE_TOOL_NAME](
    "id",
    { mode: "plan", summary: "exit" },
    undefined,
    undefined,
    createMockCtx(),
  );

  assert.deepEqual(appendedEntries, [
    { customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: "plan" } },
    { customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: null } },
  ]);
});

test("session_start restores a persisted mode without a duplicate state message", async () => {
  const { emit } = setup();
  const ctx = createMockCtx({
    branch: [
      { type: "custom", customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: "plan" } },
      {
        type: "custom_message",
        customType: MODE_MESSAGE_CUSTOM_TYPE,
        details: { modeName: "plan" },
      },
    ],
  });
  await emit("session_start", {}, ctx);

  assert.equal(await emit("before_agent_start"), undefined);
  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }, ctx));
  assert.match(gated?.reason ?? "", /In plan mode/);
});

test("session_tree restores the persisted disabled state", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit(
    "session_tree",
    {},
    createMockCtx({
      branch: [{ type: "custom", customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: null } }],
    }),
  );

  const allowed = await emit("tool_call", { toolName: "bash", input: { command: "x" } });
  assert.equal(allowed, undefined, "a persisted disabled state must ungate tools");
});

test("an invalid persisted trigger only notifies and leaves the current mode unchanged", async () => {
  const { emit } = setup();
  const notifications: string[] = [];
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit(
    "session_tree",
    {},
    createMockCtx({
      branch: [{ type: "custom", customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: 42 } }],
      ui: { notify: (text: string) => notifications.push(text) },
    }),
  );

  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }));
  assert.match(gated?.reason ?? "", /In plan mode/);
  assert.deepEqual(notifications, ["tools-switch: failed to restore gating mode: invalid trigger record"]);
});

test("a removed persisted mode only notifies and does not switch modes", async () => {
  const { emit } = setup();
  const notifications: string[] = [];
  await emit("session_start");
  await emit("input", { text: "/plan-mode" });
  await emit(
    "session_tree",
    {},
    createMockCtx({
      branch: [{ type: "custom", customType: MODE_TRIGGER_CUSTOM_TYPE, data: { modeName: "removed" } }],
      ui: { notify: (text: string) => notifications.push(text) },
    }),
  );

  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }));
  assert.match(gated?.reason ?? "", /In plan mode/);
  assert.deepEqual(notifications, [
    'tools-switch: failed to restore gating mode: unknown mode "removed"',
  ]);
});

test("registers and formats the persisted trigger-entry renderer", () => {
  const { entryRenderers } = setup();
  assert.ok(entryRenderers[MODE_TRIGGER_CUSTOM_TYPE]);
  assert.equal(formatModeTriggerEntry({ modeName: "plan" }), "Triggered: tool gating enabled. (mode: plan)");
  assert.equal(formatModeTriggerEntry({ modeName: null }), "Triggered: tool gating disabled.");
  assert.equal(formatModeTriggerEntry({}), "Triggered: tool gating record is invalid.");
});

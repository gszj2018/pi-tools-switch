/**
 * Integration tests for the gating event flow (extension/tool-gating.ts).
 *
 * Drives the module through a lightweight mock of the pi extension API and
 * mock extension contexts, covering the cross-event behavior that pure unit
 * tests cannot reach: mode-state message injection timing and dedup, the
 * steering guard flag, finish-tool active-tools churn, tool_call gating, and
 * the finish tool's execute responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../extension/tool-gating.ts";
import { DEFAULT_CONFIG, type Config } from "../extension/config.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CWD = "C:/proj";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockUi {
  setStatus: () => void;
  notify: (text: string, level?: string) => void;
  select: () => Promise<string>;
  input: () => Promise<string>;
}

/** A minimal extension context with a configurable UI. */
function createMockCtx(overrides: { cwd?: string; hasUI?: boolean; ui?: Partial<MockUi> } = {}): ExtensionContext {
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
  } as unknown as ExtensionContext;
}

interface MockPi {
  on: (event: string, handler: Handler) => void;
  emit: (event: string, eventData: unknown, ctx: unknown) => Promise<unknown>;
  getActiveTools: () => string[];
  setActiveTools: (tools: string[]) => void;
  registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => void;
  registerCommand: () => void;
}

/** A mock pi capturing event handlers and tool registrations. */
function createMockPi() {
  const handlers: { event: string; handler: Handler }[] = [];
  let activeTools: string[] = [];
  const tools: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
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
    registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools[def.name] = def.execute;
    },
    registerCommand: () => {},
  } as MockPi;

  return {
    pi: pi as unknown as ExtensionAPI,
    /** Fire an event with a fresh default context unless one is given. */
    emit: (event: string, data: unknown = {}, ctx: unknown = createMockCtx()) =>
      pi.emit(event, data, ctx),
    activeTools: (): string[] => activeTools,
    tools,
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
  message: { customType: string; content: string; display: boolean };
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

interface FinishToolResult {
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

// --- A. Mode-state message injection timing and dedup ---------------------

test("first turn without a trigger injects the no-mode message", async () => {
  const { emit } = setup();
  await emit("session_start");
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a mode-state message on the first turn");
  assert.equal(msg!.customType, "pi-tools-switch-mode");
  assert.equal(msg!.display, true);
  assert.match(msg!.content, /not currently in any gating mode/);
  assert.match(msg!.content, /any available tool/);
});

test("entering a mode injects the mode-state message and adds the finish tool", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode draw a plan" });
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a mode-state message when entering the mode");
  assert.equal(msg!.customType, "pi-tools-switch-mode");
  assert.match(msg!.content, /You are in plan mode/);
  assert.match(msg!.content, /Allowed tools/);
  assert.ok(activeTools().includes("finish_plan_mode"), "finish tool should be active");
});

test("a repeated trigger does not re-inject the same mode message", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode first" });
  assert.ok(injected(await emit("before_agent_start")));
  await emit("agent_settled");
  await emit("input", { text: "/skill:plan-mode again" });
  assert.equal(await emit("before_agent_start"), undefined, "no message when the mode is unchanged");
});

test("the mode persists across turns: a plain turn stays gated without re-injection", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
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

test("switching to a different mode injects the new mode message and swaps the finish tool", async () => {
  const { emit, activeTools } = setup(EXPLORE_CONFIG);
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  await emit("input", { text: "/skill:explore" });
  assert.ok(activeTools().includes("finish_explore_mode"), "new mode's finish tool active");
  assert.ok(!activeTools().includes("finish_plan_mode"), "previous finish tool removed");
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a message when switching modes");
  assert.match(msg!.content, /You are in explore mode/);
});

test("the finish tool stays active after agent_settled while the mode persists", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  assert.ok(activeTools().includes("finish_plan_mode"));
  await emit("agent_settled");
  assert.ok(activeTools().includes("finish_plan_mode"), "mode persists: finish tool stays active");
});

test("the exit trigger exits the mode, removes the finish tool, and ungates tools", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  assert.ok(activeTools().includes("finish_plan_mode"));
  await emit("input", { text: "/skill:normal-mode" });
  assert.ok(!activeTools().includes("finish_plan_mode"), "finish tool removed on exit");
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a no-mode message after exiting");
  assert.match(msg!.content, /not currently in any gating mode/);
  const allowed = await emit("tool_call", { toolName: "bash", input: { command: "x" } });
  assert.equal(allowed, undefined, "tools are ungated after exiting");
});

test("the exit trigger with no active mode is harmless", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:normal-mode" });
  assert.deepEqual(activeTools(), [], "no finish tools without an active mode");
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "the first turn still reports the no-mode state");
  assert.match(msg!.content, /not currently in any gating mode/);
});

// --- B. Steering guard ------------------------------------------------------

test("steering input during a run cannot change the mode and notifies an error", async () => {
  const { emit, activeTools } = setup(EXPLORE_CONFIG);
  const notified: string[] = [];
  const ctx = createMockCtx({ ui: { notify: (text: string) => notified.push(text) } });
  await emit("session_start");
  // Turn 1: enter plan mode.
  await emit("input", { text: "/skill:plan-mode" });
  assert.ok(injected(await emit("before_agent_start")));
  // A mode trigger arrives mid-run (guard raised): the input is consumed so it
  // never reaches the agent, the mode stays unchanged, and an error notice is
  // shown.
  const blockedModeInput = await emit("input", { text: "/skill:explore" }, ctx);
  assert.deepEqual(blockedModeInput, { action: "handled" }, "input during the guard is consumed");
  assert.equal(notified.length, 1, "a mode trigger during the guard should notify an error");
  assert.match(notified[0], /Cannot switch the gating mode/);
  // An exit trigger during the run is rejected the same way.
  const blockedExitInput = await emit("input", { text: "/skill:normal-mode" }, ctx);
  assert.deepEqual(blockedExitInput, { action: "handled" });
  assert.equal(notified.length, 2, "an exit trigger during the guard should also notify");
  assert.ok(activeTools().includes("finish_plan_mode"), "the mode is unchanged");
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
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  const result = await emit("input", { text: "please continue" }, ctx);
  assert.equal(result, undefined, "ordinary input during the guard is not blocked");
  assert.deepEqual(notified, [], "plain input during the guard stays quiet");
});

// --- C. tool_call gating while a mode is active ----------------------------

test("tool calls are gated while the mode is active", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  const gated = blocked(await emit("tool_call", { toolName: "bash", input: { command: "x" } }));
  assert.ok(gated, "bash should be blocked in plan mode");
  assert.match(gated!.reason ?? "", /In plan mode/);
  const allowed = await emit("tool_call", { toolName: "read", input: {} });
  assert.equal(allowed, undefined, "read should pass through");
});

test("write is allowed inside allowWriteDir and blocked outside", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  const inDir = await emit("tool_call", {
    toolName: "write",
    input: { path: "C:/proj/.agents/plans/plan.md" },
  });
  assert.equal(inDir, undefined, "write inside allowWriteDir should pass");
  const outDir = blocked(
    await emit("tool_call", { toolName: "write", input: { path: "C:/proj/src/file.ts" } }),
  );
  assert.ok(outDir, "write outside allowWriteDir should be blocked");
});

// --- D. Finish tool execute responses ---------------------------------------

test("finish tool non-interactive Accept-and-exit terminates and closes the mode", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  const result = (await tools["finish_plan_mode"](
    "id",
    { summary: "Plan done" },
    undefined,
    undefined,
    createMockCtx(),
  )) as FinishToolResult;
  assert.equal(result.terminate, true);
  assert.match(result.content?.[0]?.text ?? "", /The user has accepted\. Exiting plan mode now\./);
  assert.deepEqual(result.details, { summary: "Plan done" });
  assert.ok(!activeTools().includes("finish_plan_mode"), "accept-and-exit closes the mode");
});

test("finish tool interactive Accept-and-exit terminates and closes the mode", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  const result = (await tools["finish_plan_mode"](
    "id",
    { summary: "done" },
    undefined,
    undefined,
    createMockCtx({ hasUI: true, ui: { select: async () => "Accept and exit mode" } }),
  )) as FinishToolResult;
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { summary: "done" });
  assert.ok(!activeTools().includes("finish_plan_mode"), "accept-and-exit closes the mode");
});

test("finish tool Accept-and-stay terminates but keeps the mode active", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  const result = (await tools["finish_plan_mode"](
    "id",
    { summary: "done" },
    undefined,
    undefined,
    createMockCtx({ hasUI: true, ui: { select: async () => "Accept and stay in mode" } }),
  )) as FinishToolResult;
  assert.equal(result.terminate, true);
  assert.match(result.content?.[0]?.text ?? "", /still in plan mode/);
  assert.deepEqual(result.details, { summary: "done" });
  assert.ok(activeTools().includes("finish_plan_mode"), "mode stays active after accept-and-stay");
  await emit("agent_settled");
  assert.equal(await emit("before_agent_start"), undefined, "no re-injection for an unchanged mode");
});

test("finish tool Refine keeps the turn running with a refinement hint", async () => {
  const { emit, tools, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  const result = (await tools["finish_plan_mode"](
    "id",
    { summary: "done" },
    undefined,
    undefined,
    createMockCtx({
      hasUI: true,
      ui: { select: async () => "Refine", input: async () => "add tests" },
    }),
  )) as FinishToolResult;
  assert.equal(result.terminate, undefined, "refine must not terminate the turn");
  assert.match(result.content?.[0]?.text ?? "", /Refinement hint: add tests/);
  assert.deepEqual(result.details, { summary: "done" });
  assert.ok(activeTools().includes("finish_plan_mode"), "refine keeps the mode active");
});

test("finish tool Refine omits the hint when the refinement input is blank", async () => {
  const { tools } = setup();
  const result = (await tools["finish_plan_mode"](
    "id",
    { summary: "done" },
    undefined,
    undefined,
    createMockCtx({
      hasUI: true,
      ui: { select: async () => "Refine", input: async () => "   " },
    }),
  )) as FinishToolResult;
  assert.equal(result.terminate, undefined);
  assert.doesNotMatch(result.content?.[0]?.text ?? "", /Refinement hint/);
  assert.deepEqual(result.details, { summary: "done" });
});

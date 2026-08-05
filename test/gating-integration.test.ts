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
  notify: () => void;
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
    explore: { trigger: "/skill:explore", allowTools: [], allowWriteDir: [] },
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

test("a turn without a trigger after a mode turn injects the no-mode message", async () => {
  const { emit } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  await emit("input", { text: "plain question" });
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a no-mode message after leaving the mode");
  assert.match(msg!.content, /not currently in any gating mode/);
});

test("switching to a different mode injects the new mode message", async () => {
  const { emit } = setup(EXPLORE_CONFIG);
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  await emit("agent_settled");
  await emit("input", { text: "/skill:explore" });
  const msg = injected(await emit("before_agent_start"));
  assert.ok(msg, "expected a message when switching modes");
  assert.match(msg!.content, /You are in explore mode/);
});

test("the finish tool is removed from active tools at agent_settled", async () => {
  const { emit, activeTools } = setup();
  await emit("session_start");
  await emit("input", { text: "/skill:plan-mode" });
  await emit("before_agent_start");
  assert.ok(activeTools().includes("finish_plan_mode"));
  await emit("agent_settled");
  assert.ok(!activeTools().includes("finish_plan_mode"), "finish tool should be removed on settle");
});

// --- B. Steering guard ------------------------------------------------------

test("steering input during a run cannot change the mode; settle clears the guard", async () => {
  const { emit } = setup(EXPLORE_CONFIG);
  await emit("session_start");
  // Turn 1: enter plan mode.
  await emit("input", { text: "/skill:plan-mode" });
  assert.ok(injected(await emit("before_agent_start")));
  // Steering input arrives mid-run (guard raised): must not switch to explore.
  await emit("input", { text: "/skill:explore" });
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

test("finish tool non-interactive Accept terminates with summary in details", async () => {
  const { tools } = setup();
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
});

test("finish tool interactive Accept terminates and reports exit", async () => {
  const { tools } = setup();
  const result = (await tools["finish_plan_mode"](
    "id",
    { summary: "done" },
    undefined,
    undefined,
    createMockCtx({ hasUI: true }),
  )) as FinishToolResult;
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { summary: "done" });
});

test("finish tool Refine keeps the turn running with a refinement hint", async () => {
  const { tools } = setup();
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

/**
 * Unit tests for system prompt injection (extension/system-prompt.ts):
 * the main registration appends both guides and owns the SPL status bar;
 * the subagent registration appends only the tool guide and owns no status
 * bar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATING_MODE_GUIDANCE_PROMPT,
  TOOL_GUIDE_PROMPT,
  register,
  registerForSubagent,
} from "../extension/system-prompt.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A minimal mock pi capturing event handlers. */
function createMockPi() {
  const handlers: { event: string; handler: Handler }[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.push({ event, handler });
    },
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    events: (): string[] => handlers.map((h) => h.event),
    async emit(event: string, data: unknown): Promise<unknown> {
      let result: unknown;
      for (const h of handlers) {
        if (h.event === event) result = await h.handler(data, {});
      }
      return result;
    },
  };
}

interface SystemPromptResult {
  systemPrompt: string;
}

function prompt(result: unknown): string {
  return (result as SystemPromptResult).systemPrompt;
}

test("register appends the tool guide and the gating guidance", async () => {
  const mock = createMockPi();
  register(mock.pi);
  const result = await mock.emit("before_agent_start", { systemPrompt: "base" });
  assert.ok(prompt(result).startsWith("base"));
  assert.ok(prompt(result).includes(TOOL_GUIDE_PROMPT));
  assert.ok(prompt(result).includes(GATING_MODE_GUIDANCE_PROMPT));
});

test("register owns the SPL status bar events", () => {
  const mock = createMockPi();
  register(mock.pi);
  const events = mock.events();
  assert.ok(events.includes("session_start"), "session_start handler expected");
  assert.ok(events.includes("agent_start"), "agent_start handler expected");
  assert.ok(events.includes("before_agent_start"), "before_agent_start handler expected");
});

test("registerForSubagent appends only the tool guide", async () => {
  const mock = createMockPi();
  registerForSubagent(mock.pi);
  const result = await mock.emit("before_agent_start", { systemPrompt: "base" });
  assert.ok(prompt(result).startsWith("base"));
  assert.ok(prompt(result).includes(TOOL_GUIDE_PROMPT));
  assert.ok(!prompt(result).includes(GATING_MODE_GUIDANCE_PROMPT));
});

test("registerForSubagent owns no status bar events", () => {
  const mock = createMockPi();
  registerForSubagent(mock.pi);
  assert.deepEqual(mock.events(), ["before_agent_start"]);
});

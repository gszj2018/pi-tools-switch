/**
 * Integration tests for system prompt injection (extension/system-prompt.ts),
 * driven through a mock pi: both registration paths append the same complete
 * guidance, while only the main registration owns the SPL status bar.
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

test("registerForSubagent appends the same complete guidance as register", async () => {
  const mainMock = createMockPi();
  const subagentMock = createMockPi();
  register(mainMock.pi);
  registerForSubagent(subagentMock.pi);

  const mainResult = await mainMock.emit("before_agent_start", { systemPrompt: "base" });
  const subagentResult = await subagentMock.emit("before_agent_start", { systemPrompt: "base" });

  assert.equal(prompt(subagentResult), prompt(mainResult));
  assert.equal(
    prompt(subagentResult),
    `base\n\n${TOOL_GUIDE_PROMPT}\n\n${GATING_MODE_GUIDANCE_PROMPT}`,
  );
  assert.match(
    prompt(subagentResult),
    /If this is a subagent session, tool gating from this extension is inactive\./,
  );
});

test("registerForSubagent owns no status bar events", () => {
  const mock = createMockPi();
  registerForSubagent(mock.pi);
  assert.deepEqual(mock.events(), ["before_agent_start"]);
});

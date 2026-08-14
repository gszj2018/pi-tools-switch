/**
 * Integration tests for the subagent-only registration in tool-gating.ts.
 * The subagent path appends one inactive-gating notice and registers no tools,
 * commands, gating lifecycle handlers, or status UI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_GATING_INACTIVE_PROMPT,
  registerForSubagent,
} from "../extension/tool-gating.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function createMockPi() {
  const handlers: { event: string; handler: Handler }[] = [];
  let registeredTools = 0;
  let registeredCommands = 0;
  let activeToolChanges = 0;

  // noinspection JSUnusedGlobalSymbols
  const pi = {
    on(event: string, handler: Handler) {
      handlers.push({ event, handler });
    },
    registerTool() {
      registeredTools += 1;
    },
    registerCommand() {
      registeredCommands += 1;
    },
    setActiveTools() {
      activeToolChanges += 1;
    },
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    events: (): string[] => handlers.map(({ event }) => event),
    registrations: () => ({ registeredTools, registeredCommands, activeToolChanges }),
    async emit(event: string, data: unknown): Promise<unknown> {
      let result: unknown;
      for (const entry of handlers) {
        if (entry.event === event) result = await entry.handler(data, {});
      }
      return result;
    },
  };
}

interface SystemPromptResult {
  systemPrompt: string;
}

test("registerForSubagent appends only the inactive-gating system prompt notice", async () => {
  const mock = createMockPi();
  registerForSubagent(mock.pi);

  const result = (await mock.emit("before_agent_start", {
    systemPrompt: "base",
  })) as SystemPromptResult;

  assert.equal(result.systemPrompt, `base\n\n${SUBAGENT_GATING_INACTIVE_PROMPT}`);
  assert.match(result.systemPrompt, /tool gating from the pi-tools-switch extension is inactive/);
  assert.match(result.systemPrompt, /follow the subagent's own instructions/);
});

test("registerForSubagent registers no tools, commands, gates, or status events", () => {
  const mock = createMockPi();
  registerForSubagent(mock.pi);

  assert.deepEqual(mock.events(), ["before_agent_start"]);
  assert.deepEqual(mock.registrations(), {
    registeredTools: 0,
    registeredCommands: 0,
    activeToolChanges: 0,
  });
});

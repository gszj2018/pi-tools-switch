/**
 * Shared in-memory ExtensionAPI mock for integration tests.
 *
 * Pure in-memory only: no file writes, no environment changes, no network,
 * and no external commands. Handlers run in registration order and `emit`
 * resolves to the last handler's result.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { BUILTIN_TOOL_NAMES } from "../../extension/utils.ts";

export type MockEventHandler = (event: unknown, ctx: unknown) => unknown;

/** A tool definition captured by registerTool. */
export interface MockToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: string;
  parameters?: unknown;
  execute?: (...args: unknown[]) => Promise<unknown>;
}

/** A command definition captured by registerCommand. */
export interface MockCommandDefinition {
  description?: string;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: unknown) => void | Promise<void>;
}

export interface MockPiOptions {
  /** Active tools before any registration; defaults to none. */
  initialActiveTools?: string[];
  /** Tools reported by getAllTools; defaults to the built-in list plus one external tool. */
  initialAllTools?: string[];
}

export function createMockPi(options: MockPiOptions = {}) {
  let activeTools = [...(options.initialActiveTools ?? [])];
  const allToolNames = [
    ...(options.initialAllTools ?? [...BUILTIN_TOOL_NAMES, "external_tool"]),
  ];
  const commands = new Map<string, MockCommandDefinition>();
  const handlers = new Map<string, MockEventHandler[]>();
  const tools: Record<string, NonNullable<MockToolDefinition["execute"]>> = {};
  const toolDefinitions: Record<string, MockToolDefinition> = {};
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const entryRenderers: Record<string, (entry: { data?: unknown }) => unknown> = {};

  const pi = {
    on(eventName: string, handler: MockEventHandler) {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
    registerCommand(name: string, definition: MockCommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(definition: MockToolDefinition) {
      toolDefinitions[definition.name] = definition;
      if (definition.execute) tools[definition.name] = definition.execute;
      if (!allToolNames.includes(definition.name)) allToolNames.push(definition.name);
    },
    registerEntryRenderer(customType: string, renderer: (entry: { data?: unknown }) => unknown) {
      entryRenderers[customType] = renderer;
    },
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
    getAllTools: () => allToolNames.map((name) => ({ name })),
  } as unknown as ExtensionAPI;

  return {
    pi,
    commands,
    tools,
    toolDefinitions,
    appendedEntries,
    entryRenderers,
    /** Run all handlers for an event in registration order; resolves to the last result. */
    async emit(eventName: string, eventData?: unknown, ctx?: unknown): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(eventName) ?? []) {
        result = await handler(eventData, ctx);
      }
      return result;
    },
    activeTools: (): string[] => [...activeTools],
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
  };
}

/**
 * Shared in-memory ExtensionContext mock for integration tests.
 *
 * Pure in-memory only: no file writes, no environment changes, no network,
 * and no external commands. UI calls are captured into returned arrays.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A UI notification captured from ctx.ui.notify. */
export interface MockNotification {
  message: string;
  level?: string;
}

/** A status bar update captured from ctx.ui.setStatus. */
export interface MockStatus {
  key: string;
  value: string | undefined;
}

/** Partial UI overrides; unoverridden methods keep their capturing defaults. */
export interface MockUiOverrides {
  notify?: (text: string, level?: string) => void;
  select?: () => Promise<string>;
  input?: () => Promise<string>;
}

export interface MockCtxOptions {
  cwd?: string;
  hasUI?: boolean;
  ui?: MockUiOverrides;
  /** Entries returned by sessionManager.getBranch() unless branchError is set. */
  branch?: unknown[];
  /** When set, getBranch() throws this error. */
  branchError?: Error;
}

export function createMockCtx(
  options: MockCtxOptions = {},
): { ctx: ExtensionContext; notifications: MockNotification[]; statuses: MockStatus[] } {
  const notifications: MockNotification[] = [];
  const statuses: MockStatus[] = [];
  const ctx = {
    cwd: options.cwd ?? "/project",
    hasUI: options.hasUI ?? false,
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      select: async () => "Accept",
      input: async () => "",
      ...options.ui,
    },
    sessionManager: {
      getBranch: () => {
        if (options.branchError) throw options.branchError;
        return (options.branch ?? []) as never;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, statuses };
}

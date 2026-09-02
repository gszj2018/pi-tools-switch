/** Shared immutable status types for the tool-status feature. */

/** An immutable status record for a tool known to Pi. */
export interface ToolStatusSnapshot {
  readonly name: string;
  readonly enabled: boolean;
  readonly builtIn: boolean;
}

/** Read-only accessor for fresh snapshots of Pi tool state. */
export type ToolStatusReader = () => readonly ToolStatusSnapshot[];

/** Immutable, derived gate status for a single tool. */
export interface GatingToolStatus {
  readonly unrestricted: boolean;
  readonly hasAllowedWriteDir: boolean;
}

/** Read-only accessor for the derived gating status of a named tool. */
export type GatingStatusReader = (toolName: string) => GatingToolStatus;

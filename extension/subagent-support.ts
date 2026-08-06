/**
 * Subagent detection helpers for pi-tools-switch.
 *
 * Stateless pure helpers (env-var list + detection predicate). The extension
 * entry (index.ts) runs the detection once at the factory layer and skips
 * registering feature modules that must not run inside subagents; feature
 * modules therefore hold no subagent state of their own.
 */
/** Built-in subagent detection environment variables. */
export const BUILTIN_SUBAGENT_ENV_VARS: readonly string[] = [
  // pi-agent-router (original)
  "PI_IS_SUBAGENT",
  "PI_SUBAGENT_SESSION_ID",
  "PI_AGENT_ROUTER_SUBAGENT",
  // nicobailon/pi-subagents
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_DEPTH",
  // HazAT/pi-interactive-subagents
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
];

/** True when any known subagent env var (built-in or user-extended) is set. */
export function isSubagentEnv(env: NodeJS.ProcessEnv, extraVars: readonly string[]): boolean {
  const vars = [...BUILTIN_SUBAGENT_ENV_VARS, ...extraVars];
  return vars.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}

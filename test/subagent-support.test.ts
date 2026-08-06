/**
 * Unit tests for subagent detection (extension/subagent-support.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SUBAGENT_ENV_VARS, isSubagentEnv } from "../extension/subagent-support.ts";

test("BUILTIN_SUBAGENT_ENV_VARS covers the documented subagent frameworks", () => {
  const expected = [
    "PI_IS_SUBAGENT",
    "PI_SUBAGENT_SESSION_ID",
    "PI_AGENT_ROUTER_SUBAGENT",
    "PI_SUBAGENT_CHILD",
    "PI_SUBAGENT_RUN_ID",
    "PI_SUBAGENT_CHILD_AGENT",
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_SESSION",
    "PI_SUBAGENT_ACTIVITY_FILE",
  ];
  assert.deepEqual([...BUILTIN_SUBAGENT_ENV_VARS].sort(), expected.sort());
});

test("isSubagentEnv detects built-in vars", () => {
  assert.equal(isSubagentEnv({}, []), false);
  assert.equal(isSubagentEnv({ PI_IS_SUBAGENT: "1" }, []), true);
  assert.equal(isSubagentEnv({ PI_SUBAGENT_SESSION_ID: "abc" }, []), true);
  assert.equal(isSubagentEnv({ PI_SUBAGENT_ACTIVITY_FILE: "/tmp/x.json" }, []), true);
});

test("isSubagentEnv treats empty-string values as not set", () => {
  assert.equal(isSubagentEnv({ PI_IS_SUBAGENT: "" }, []), false);
  assert.equal(isSubagentEnv({ PI_SUBAGENT_RUN_ID: "" }, []), false);
});

test("isSubagentEnv honors extra user vars on top of the built-in list", () => {
  assert.equal(isSubagentEnv({ PI_SUBAGENT: "1" }, []), false);
  assert.equal(isSubagentEnv({ PI_SUBAGENT: "1" }, ["PI_SUBAGENT"]), true);
  assert.equal(isSubagentEnv({ MY_SUBAGENT_VAR: "1" }, ["MY_SUBAGENT_VAR"]), true);
});

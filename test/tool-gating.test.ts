/**
 * Unit tests for tool gating (extension/tool-gating.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_GATING_MODES,
  decideToolCall,
  formatModeStatus,
  matchTrigger,
  mergeGatingModes,
} from "../extension/tool-gating.ts";
import { resolveDir } from "../extension/utils.ts";

const CWD = "C:/proj";
const FINISH = ["finish_plan_mode"];
const ABS_PLANS_DIR = resolveDir(".agents/plans", CWD);
const BUILTIN_PLAN = BUILTIN_GATING_MODES["plan"];

test("mergeGatingModes includes the built-in plan mode under the name 'plan'", () => {
  const merged = mergeGatingModes({});
  assert.deepEqual(merged["plan"], BUILTIN_PLAN);
  assert.equal(merged["plan"].trigger, "/skill:plan-mode");
});

test("mergeGatingModes honors user overrides and additions", () => {
  const merged = mergeGatingModes({
    plan: { trigger: "/plan", allowTools: ["bash"], allowWriteDir: [] },
    review: { trigger: "/review", allowTools: [], allowWriteDir: ["docs"] },
  });
  assert.deepEqual(merged["plan"], { trigger: "/plan", allowTools: ["bash"], allowWriteDir: [] });
  assert.deepEqual(merged["review"], { trigger: "/review", allowTools: [], allowWriteDir: ["docs"] });
  // Built-in object untouched by overrides.
  assert.deepEqual(BUILTIN_PLAN.allowWriteDir, [".agents/plans"]);
});

test("matchTrigger matches the first mode whose trigger is a prefix", () => {
  const modes = mergeGatingModes({});
  assert.equal(matchTrigger("/skill:plan-mode do a plan", modes), "plan");
  assert.equal(matchTrigger("/skill:plan-mode", modes), "plan");
});

test("matchTrigger returns undefined when nothing matches", () => {
  const modes = mergeGatingModes({});
  assert.equal(matchTrigger("just a prompt", modes), undefined);
  assert.equal(matchTrigger("/skill:other-mode", modes), undefined);
  assert.equal(matchTrigger("", modes), undefined);
});

test("matchTrigger respects user mode order and extra triggers", () => {
  const modes = mergeGatingModes({
    a: { trigger: "/a", allowTools: [], allowWriteDir: [] },
    b: { trigger: "/ab", allowTools: [], allowWriteDir: [] },
  });
  assert.equal(matchTrigger("/ab x", modes), "a"); // "/a" comes first
});

test("decideToolCall allows everything when no mode is active", () => {
  const d = decideToolCall("bash", { command: "rm -rf /" }, undefined, undefined, FINISH, CWD);
  assert.deepEqual(d, { allowed: true });
});

test("decideToolCall allows finish tools", () => {
  const d = decideToolCall("finish_plan_mode", { summary: "done" }, "plan", BUILTIN_PLAN, FINISH, CWD);
  assert.deepEqual(d, { allowed: true });
});

test("decideToolCall allows read-only tools", () => {
  for (const tool of ["read", "find", "grep", "ls"]) {
    const d = decideToolCall(tool, {}, "plan", BUILTIN_PLAN, FINISH, CWD);
    assert.equal(d.allowed, true, `${tool} should be allowed`);
  }
});

test("decideToolCall allows allowTools entries", () => {
  const mode = { ...BUILTIN_PLAN, allowTools: ["bash"] };
  const d = decideToolCall("bash", { command: "echo hi" }, "plan", mode, FINISH, CWD);
  assert.deepEqual(d, { allowed: true });
});

test("decideToolCall allows write/edit inside allowWriteDir", () => {
  for (const tool of ["write", "edit"]) {
    const d = decideToolCall(
      tool,
      { path: "C:/proj/.agents/plans/plan.md" },
      "plan",
      BUILTIN_PLAN,
      FINISH,
      CWD,
    );
    assert.equal(d.allowed, true, `${tool} inside allowWriteDir should be allowed`);
  }
});

test("decideToolCall blocks write/edit outside allowWriteDir with reason", () => {
  for (const tool of ["write", "edit"]) {
    const d = decideToolCall(
      tool,
      { path: "C:/proj/src/file.ts" },
      "plan",
      BUILTIN_PLAN,
      FINISH,
      CWD,
    );
    assert.equal(d.allowed, false, `${tool} outside should be blocked`);
    assert.ok(
      d.reason?.includes("In plan mode, file modification is not allowed"),
      `reason: ${d.reason}`,
    );
    assert.ok(d.reason?.includes("Except in the following directories"), `reason lists dirs: ${d.reason}`);
    assert.ok(d.reason?.includes(ABS_PLANS_DIR), `reason has abs dir: ${d.reason}`);
  }
});

test("decideToolCall blocks write/edit when allowWriteDir is empty (no dir suffix)", () => {
  const mode = { trigger: "/x", allowTools: [], allowWriteDir: [] };
  const d = decideToolCall("write", { path: "C:/anything.md" }, "x", mode, FINISH, CWD);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "In x mode, file modification is not allowed");
});

test("decideToolCall allows write when allowTools includes it (bypasses dir check)", () => {
  const mode = { ...BUILTIN_PLAN, allowTools: ["write"] };
  const d = decideToolCall("write", { path: "C:/anywhere.md" }, "plan", mode, FINISH, CWD);
  assert.deepEqual(d, { allowed: true });
});

test("decideToolCall blocks other tools (bash, external) with reason", () => {
  for (const tool of ["bash", "my_custom_tool"]) {
    const d = decideToolCall(tool, {}, "plan", BUILTIN_PLAN, FINISH, CWD);
    assert.equal(d.allowed, false, `${tool} should be blocked`);
    assert.equal(d.reason, "In plan mode, this tool is not allowed");
  }
});

test("decideToolCall blocks write with missing or non-string path", () => {
  const d1 = decideToolCall("write", {}, "plan", BUILTIN_PLAN, FINISH, CWD);
  assert.equal(d1.allowed, false);
  const d2 = decideToolCall("write", { path: 42 }, "plan", BUILTIN_PLAN, FINISH, CWD);
  assert.equal(d2.allowed, false);
});

test("formatModeStatus renders active and inactive", () => {
  assert.equal(formatModeStatus(undefined), "[MODE: -]");
  assert.equal(formatModeStatus("plan"), "[MODE: plan]");
});

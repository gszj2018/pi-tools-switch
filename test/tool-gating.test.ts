/**
 * Unit tests for tool gating (extension/tool-gating.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  BUILTIN_GATING_EXIT_TRIGGERS,
  BUILTIN_GATING_MODES,
  EXIT_MODE_TOOL_NAME,
  buildBlockReason,
  buildModeMessage,
  decideToolCall,
  formatModeStatus,
  getGatingToolStatus,
  isToolUnrestricted,
  matchAnyTrigger,
  matchTrigger,
  mergeGatingExitTriggers,
  mergeGatingModes,
  shouldInjectModeMessage,
} from "../extension/tool-gating.ts";
import { resolveDir } from "../extension/utils.ts";

const CWD = process.platform === "win32" ? "D:\\workspace\\proj" : "/workspace/proj";
const PLANS_DIR = path.resolve(CWD, ".agents", "plans");
const PLAN_FILE = path.join(PLANS_DIR, "plan.md");
const NESTED_PLAN_FILE = path.join(PLANS_DIR, "nested", "plan.md");
const OUTSIDE_FILE = path.resolve(CWD, "src", "file.ts");
const PARENT_DIR = path.resolve(PLANS_DIR, "..");
const ABS_PLANS_DIR = resolveDir(".agents/plans", CWD);
const BUILTIN_PLAN = BUILTIN_GATING_MODES["plan"];

test("mergeGatingModes includes the built-in plan mode under the name 'plan'", () => {
  const merged = mergeGatingModes({});
  assert.deepEqual(merged["plan"], BUILTIN_PLAN);
  assert.deepEqual(merged["plan"].trigger, ["/plan-mode"]);
});

test("mergeGatingExitTriggers falls back to the built-in prefix when the config list is empty", () => {
  assert.deepEqual(mergeGatingExitTriggers([]), ["/normal-mode"]);
  assert.deepEqual(BUILTIN_GATING_EXIT_TRIGGERS, ["/normal-mode"]);
  // The result is a fresh array: mutating it must not alias the constant.
  const merged = mergeGatingExitTriggers([]);
  merged.push("EXTRA:");
  assert.deepEqual(BUILTIN_GATING_EXIT_TRIGGERS, ["/normal-mode"]);
});

test("mergeGatingExitTriggers fully overrides the built-in prefix with a non-empty list", () => {
  assert.deepEqual(mergeGatingExitTriggers(["NORMAL:", "EXIT:"]), ["NORMAL:", "EXIT:"]);
  // No built-in prefix is kept when the config provides its own.
  assert.ok(!mergeGatingExitTriggers(["NORMAL:"]).includes("/normal-mode"));
});

test("mergeGatingModes honors user overrides and additions", () => {
  const merged = mergeGatingModes({
    plan: { trigger: ["PLAN:"], allowTools: ["bash"], allowWriteDir: [] },
    review: { trigger: ["REVIEW:"], allowTools: [], allowWriteDir: ["docs"] },
  });
  assert.deepEqual(merged["plan"], { trigger: ["PLAN:"], allowTools: ["bash"], allowWriteDir: [] });
  assert.deepEqual(merged["review"], { trigger: ["REVIEW:"], allowTools: [], allowWriteDir: ["docs"] });
  // Built-in object untouched by overrides.
  assert.deepEqual(BUILTIN_PLAN.allowWriteDir, [".agents/plans"]);
});

test("matchTrigger matches the first mode whose trigger is a prefix", () => {
  const modes = mergeGatingModes({});
  assert.equal(matchTrigger("/plan-mode do a plan", modes), "plan");
  assert.equal(matchTrigger("/plan-mode", modes), "plan");
});

test("matchTrigger returns undefined when nothing matches", () => {
  const modes = mergeGatingModes({});
  assert.equal(matchTrigger("just a prompt", modes), undefined);
  assert.equal(matchTrigger("/skill:other-mode", modes), undefined);
  assert.equal(matchTrigger("", modes), undefined);
});

test("matchTrigger respects user mode order and multiple triggers", () => {
  const modes = mergeGatingModes({
    a: { trigger: ["A"], allowTools: [], allowWriteDir: [] },
    b: { trigger: ["AB:", "B2:"], allowTools: [], allowWriteDir: [] },
  });
  assert.equal(matchTrigger("AB: x", modes), "a"); // "A" (mode a) comes first
  assert.equal(matchTrigger("B2: y", modes), "b"); // second trigger of mode b
});

test("matchTrigger matches any of a mode's triggers", () => {
  const modes = mergeGatingModes({
    plan: { trigger: ["/skill:plan-mode", "PLAN:"], allowTools: [], allowWriteDir: [] },
  });
  assert.equal(matchTrigger("/skill:plan-mode do it", modes), "plan");
  assert.equal(matchTrigger("PLAN: go", modes), "plan");
});

test("matchAnyTrigger matches any non-empty trigger prefix", () => {
  assert.equal(matchAnyTrigger("/skill:normal-mode", ["/skill:normal-mode", "QUIT:"]), true);
  assert.equal(matchAnyTrigger("/skill:normal-mode exit now", ["/skill:normal-mode"]), true);
  assert.equal(matchAnyTrigger("QUIT:", ["/skill:normal-mode", "QUIT:"]), true);
  assert.equal(matchAnyTrigger("plain text", ["/skill:normal-mode", "QUIT:"]), false);
  assert.equal(matchAnyTrigger("", ["/skill:normal-mode"]), false);
  assert.equal(matchAnyTrigger("X:", []), false);
});

test("decideToolCall allows everything when no mode is active", () => {
  for (const tool of ["bash", "powershell"]) {
    const d = decideToolCall(tool, { command: "echo hi" }, null, null, CWD);
    assert.deepEqual(d, { allowed: true }, `${tool} should be allowed without an active mode`);
  }
});

test("decideToolCall allows exit_mode", () => {
  const d = decideToolCall(
    EXIT_MODE_TOOL_NAME,
    { mode: "plan", summary: "done" },
    "plan",
    BUILTIN_PLAN,
    CWD,
  );
  assert.deepEqual(d, { allowed: true });
});

test("decideToolCall allows read-only tools", () => {
  for (const tool of ["read", "find", "grep", "ls"]) {
    const d = decideToolCall(tool, {}, "plan", BUILTIN_PLAN, CWD);
    assert.equal(d.allowed, true, `${tool} should be allowed`);
  }
});

test("decideToolCall allows allowTools entries", () => {
  for (const tool of ["bash", "powershell"]) {
    const mode = { ...BUILTIN_PLAN, allowTools: [tool] };
    const d = decideToolCall(tool, { command: "echo hi" }, "plan", mode, CWD);
    assert.deepEqual(d, { allowed: true }, `${tool} should be allowed by allowTools`);
  }
});

test("decideToolCall allows write/edit strictly inside allowWriteDir", () => {
  for (const tool of ["write", "edit"]) {
    for (const targetPath of [PLAN_FILE, NESTED_PLAN_FILE]) {
      const d = decideToolCall(tool, { path: targetPath }, "plan", BUILTIN_PLAN, CWD);
      assert.equal(d.allowed, true, `${tool} path ${targetPath} inside allowWriteDir should be allowed`);
    }
  }
});

test("decideToolCall blocks unsupported tool paths", () => {
  const paths = [
    "plans\u00A0plan.md",
    "@.agents/plans/plan.md",
    "~/plans/plan.md",
    "file:///workspace/proj/.agents/plans/plan.md",
  ];
  for (const tool of ["write", "edit"]) {
    for (const path of paths) {
      const decision = decideToolCall(tool, { path }, "plan", BUILTIN_PLAN, CWD);
      assert.equal(decision.allowed, false, `${tool}: ${path}`);
      assert.match(decision.reason ?? "", /In plan mode, file modification is not allowed/);
    }
  }
});

test("decideToolCall blocks write/edit paths equal to allowWriteDir", () => {
  for (const tool of ["write", "edit"]) {
    const d = decideToolCall(tool, { path: PLANS_DIR }, "plan", BUILTIN_PLAN, CWD);
    assert.equal(d.allowed, false, `${tool} path equal to allowWriteDir should be blocked`);
  }
});

test("decideToolCall preserves literal @ in allowWriteDir configuration", () => {
  const mode = { trigger: ["X:"], allowTools: [], allowWriteDir: ["@.agents/plans"] };
  const ordinaryPath = decideToolCall("write", { path: ".agents/plans/plan.md" }, "x", mode, CWD);
  assert.equal(ordinaryPath.allowed, false);

  const literalAtPath = decideToolCall(
    "write",
    { path: path.join(CWD, "@.agents", "plans", "plan.md") },
    "x",
    mode,
    CWD,
  );
  assert.equal(literalAtPath.allowed, true);
});

test("decideToolCall blocks write/edit outside allowWriteDir with reason", () => {
  for (const tool of ["write", "edit"]) {
    for (const targetPath of [
      OUTSIDE_FILE,
      // This is the immediate parent of allowWriteDir, so relative(plans, path) is exactly "..".
      PARENT_DIR,
    ]) {
      const d = decideToolCall(tool, { path: targetPath }, "plan", BUILTIN_PLAN, CWD);
      assert.equal(d.allowed, false, `${tool} outside path ${targetPath} should be blocked`);
      assert.ok(
        d.reason?.includes("In plan mode, file modification is not allowed"),
        `reason: ${d.reason}`,
      );
      assert.ok(d.reason?.includes("Except in the following directories"), `reason lists dirs: ${d.reason}`);
      assert.ok(d.reason?.includes(ABS_PLANS_DIR), `reason has abs dir: ${d.reason}`);
    }
  }
});

test("decideToolCall blocks write/edit when allowWriteDir is empty (no dir suffix)", () => {
  const mode = { trigger: ["X:"], allowTools: [], allowWriteDir: [] };
  const d = decideToolCall("write", { path: path.resolve(CWD, "anything.md") }, "x", mode, CWD);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "In x mode, file modification is not allowed");
});

test("decideToolCall allows write when allowTools includes it (bypasses dir check)", () => {
  const mode = { ...BUILTIN_PLAN, allowTools: ["write"] };
  const d = decideToolCall("write", { path: path.resolve(CWD, "anywhere.md") }, "plan", mode, CWD);
  assert.deepEqual(d, { allowed: true });
});

test("decideToolCall blocks other tools (bash, powershell, external) with reason", () => {
  for (const tool of ["bash", "powershell", "my_custom_tool"]) {
    const d = decideToolCall(tool, {}, "plan", BUILTIN_PLAN, CWD);
    assert.equal(d.allowed, false, `${tool} should be blocked`);
    assert.ok(
      d.reason?.includes("In plan mode, this tool is not allowed"),
      `reason prefix: ${d.reason}`,
    );
    assert.ok(
      d.reason?.includes("Allowed tools: exit_mode, read, find, grep, ls"),
      `reason lists allowed: ${d.reason}`,
    );
    assert.ok(
      d.reason?.includes("write/edit are conditionally allowed"),
      `reason notes write: ${d.reason}`,
    );
  }
});

test("decideToolCall appends allowTools to the allowed-tools list", () => {
  const mode = { ...BUILTIN_PLAN, allowTools: ["bash", "my_tool"] };
  const d = decideToolCall("python", {}, "plan", mode, CWD);
  assert.equal(d.allowed, false);
  assert.ok(
    d.reason?.includes("Allowed tools: exit_mode, read, find, grep, ls, bash, my_tool"),
    `reason: ${d.reason}`,
  );
});

test("buildBlockReason notes write/edit as not allowed when allowWriteDir is empty", () => {
  const mode = { trigger: ["X:"], allowTools: [], allowWriteDir: [] };
  const reason = buildBlockReason("x", mode);
  assert.equal(
    reason,
    "In x mode, this tool is not allowed. Allowed tools: exit_mode, read, find, grep, ls. write/edit are not allowed",
  );
});

test("decideToolCall blocks write with missing or non-string path", () => {
  const d1 = decideToolCall("write", {}, "plan", BUILTIN_PLAN, CWD);
  assert.equal(d1.allowed, false);
  const d2 = decideToolCall("write", { path: 42 }, "plan", BUILTIN_PLAN, CWD);
  assert.equal(d2.allowed, false);
});

test("isToolUnrestricted follows direct gate permissions without checking paths", () => {
  const mode = { trigger: ["REVIEW:"], allowTools: ["bash", "external_tool"], allowWriteDir: ["docs"] };

  assert.equal(isToolUnrestricted("anything", null), true);
  for (const toolName of ["exit_mode", "read", "find", "grep", "ls", "bash", "external_tool"]) {
    assert.equal(isToolUnrestricted(toolName, mode), true, toolName);
  }
  for (const toolName of ["write", "edit", "powershell", "other_tool"]) {
    assert.equal(isToolUnrestricted(toolName, mode), false, toolName);
  }
});

test("getGatingToolStatus returns fresh immutable derived results", () => {
  const mode = { trigger: ["REVIEW:"], allowTools: ["bash", "write"], allowWriteDir: ["docs"] };
  const pathRestricted = getGatingToolStatus("edit", mode);

  assert.deepEqual(pathRestricted, { unrestricted: false, hasAllowedWriteDir: true });
  assert.ok(Object.isFrozen(pathRestricted));
  assert.notEqual(getGatingToolStatus("edit", mode), pathRestricted);
  assert.throws(() => {
    (pathRestricted as { unrestricted: boolean }).unrestricted = true;
  });

  assert.deepEqual(getGatingToolStatus("write", mode), {
    unrestricted: true,
    hasAllowedWriteDir: false,
  });
  assert.deepEqual(getGatingToolStatus("powershell", mode), {
    unrestricted: false,
    hasAllowedWriteDir: false,
  });
  assert.deepEqual(getGatingToolStatus("anything", null), {
    unrestricted: true,
    hasAllowedWriteDir: false,
  });

  mode.allowTools.push("edit");
  mode.allowWriteDir.length = 0;
  assert.deepEqual(pathRestricted, { unrestricted: false, hasAllowedWriteDir: true });
});

test("formatModeStatus renders matching and pending reported states", () => {
  assert.equal(formatModeStatus("plan", "plan"), "[M: plan]");
  assert.equal(formatModeStatus("plan", null), "[M: plan => -]");
  assert.equal(formatModeStatus(null, "plan"), "[M: - => plan]");
  assert.equal(formatModeStatus("plan", "explore"), "[M: plan => explore]");
  assert.equal(formatModeStatus(undefined, null), "[M: ? => -]");
  assert.equal(formatModeStatus(undefined, "plan"), "[M: ? => plan]");
  assert.equal(formatModeStatus(null, null), "[M: -]");
});

test("shouldInjectModeMessage forces injection only when the reported state is unknown", () => {
  assert.equal(shouldInjectModeMessage(undefined, null), true);
  assert.equal(shouldInjectModeMessage(undefined, "plan"), true);
  assert.equal(shouldInjectModeMessage(null, null), false);
  assert.equal(shouldInjectModeMessage("plan", "plan"), false);
});

test("shouldInjectModeMessage injects when the mode changed vs the previously reported mode", () => {
  assert.equal(shouldInjectModeMessage("plan", null), true); // left the mode
  assert.equal(shouldInjectModeMessage(null, "plan"), true); // entered a mode
  assert.equal(shouldInjectModeMessage("plan", "explore"), true); // switched modes
});

test("buildModeMessage reports no active mode and free tool use", () => {
  assert.equal(
    buildModeMessage(null, null, CWD),
    "You are not currently in any gating mode. You may call any available tool.",
  );
});

test("buildModeMessage states the active mode, allowed tools, and write dirs", () => {
  const msg = buildModeMessage("plan", BUILTIN_PLAN, CWD);
  assert.ok(msg.includes("You are in plan mode"), `states mode: ${msg}`);
  assert.ok(
    msg.includes("Allowed tools: exit_mode, read, find, grep, ls"),
    `lists allowed: ${msg}`,
  );
  assert.ok(
    msg.includes("write/edit are allowed only in"),
    `notes write dirs: ${msg}`,
  );
  assert.ok(msg.includes(ABS_PLANS_DIR), `has abs dir: ${msg}`);
  // Paths are wrapped in backticks so markdown renders them as inline code
  // and the backslashes survive (plain text would escape `\.` to `.`).
  assert.ok(msg.includes(`\`${ABS_PLANS_DIR}\``), `path wrapped in backticks: ${msg}`);
  assert.ok(msg.includes("Other tools are blocked"), `notes blocking: ${msg}`);
});

test("buildModeMessage appends allowTools and notes write/edit not allowed when empty", () => {
  const mode = { trigger: ["X:"], allowTools: ["bash"], allowWriteDir: [] };
  const msg = buildModeMessage("x", mode, CWD);
  assert.ok(
    msg.includes("Allowed tools: exit_mode, read, find, grep, ls, bash"),
    `lists allowTools: ${msg}`,
  );
  assert.ok(msg.includes("write/edit are not allowed"), `notes write: ${msg}`);
});

/** Integration tests for /ptsw-status with the real status readers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register as registerBuiltinTools } from "../extension/builtin-tools.ts";
import { DEFAULT_CONFIG, type Config } from "../extension/config.ts";
import { register as registerToolGating } from "../extension/tool-gating.ts";
import { register as registerToolStatus } from "../extension/tool-status.ts";
import { createMockCtx } from "./helpers/ctx.mock.ts";
import { createMockPi } from "./helpers/pi.mock.ts";

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  gatingModes: {
    review: {
      trigger: ["REVIEW:"],
      allowTools: ["bash"],
      allowWriteDir: ["docs"],
    },
  },
};

test("ptsw-status combines registered tool and gating readers without modifying state", async () => {
  const mock = createMockPi({ initialActiveTools: ["read", "write", "external_tool"] });
  const { ctx, notifications } = createMockCtx();
  const readToolStatus = registerBuiltinTools(mock.pi, () => CONFIG);
  const readGatingStatus = registerToolGating(mock.pi, () => CONFIG);
  registerToolStatus(mock.pi, readToolStatus, readGatingStatus);

  await mock.emit("input", { text: "REVIEW:" }, ctx);
  const command = mock.commands.get("ptsw-status");
  assert.ok(command);
  await command.handler("", ctx);

  assert.deepEqual(notifications, [
    {
      message: [
        "[+][ ] read (built-in)",
        "[+][*] write (built-in)",
        "[ ][*] edit (built-in)",
        "[ ][ ] bash (built-in)",
        "[ ][-] powershell (built-in)",
        "[ ][ ] find (built-in)",
        "[ ][ ] grep (built-in)",
        "[ ][ ] ls (built-in)",
        "[+][-] external_tool",
        "[ ][ ] exit_mode",
      ].join("\n"),
      level: "info",
    },
  ]);
  assert.deepEqual(readGatingStatus("bash"), {
    unrestricted: true,
    hasAllowedWriteDir: false,
  });
  assert.deepEqual(readGatingStatus("write"), {
    unrestricted: false,
    hasAllowedWriteDir: true,
  });
  assert.deepEqual(readGatingStatus("external_tool"), {
    unrestricted: false,
    hasAllowedWriteDir: false,
  });

  await command.handler("unexpected", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "Unexpected arguments. Usage: /ptsw-status",
    level: "error",
  });
  assert.deepEqual(readGatingStatus("external_tool"), {
    unrestricted: false,
    hasAllowedWriteDir: false,
  });
});

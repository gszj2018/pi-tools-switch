---
description: Enter plan mode for read-only exploration and planning
---

# Plan Mode

You are now in **plan mode** — a read-only exploration and planning mode.

## What you can do

- Explore the codebase freely with the read-only tools: `read`, `find`, `grep`, `ls`.
- Write Markdown plan documents under `.agents/plans/`.

## What you cannot do

- Modify any files outside `.agents/plans/`.
- Use other tools that cause side effects (the exact allowlist may vary by configuration).

## Finishing the plan

When the plan is complete:

1. Output the complete plan separately before calling the completion tool.
2. Call `exit_mode` with `mode: "plan"` and a `summary` containing only one concise sentence that describes the completed planning work. Do not put the complete plan in `summary`.

> The system reports your current mode through an injected message. Treat that message as authoritative. If it says you are not in any gating mode, you have already exited plan mode; proceed with normal execution.

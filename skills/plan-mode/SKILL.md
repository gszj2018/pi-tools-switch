---
name: plan-mode
description: Enter plan mode - a read-only exploration and planning mode. Use when the user asks to plan before implementation, or to explore a codebase without making changes.
disable-model-invocation: true
---

# Plan Mode

You are now in **plan mode** - a read-only exploration and planning mode.

## What you can do

- Explore the codebase freely with the read-only tools: `read`, `find`, `grep`, `ls`.
- Write markdown plan documents under `.agents/plans/`.

## What you cannot do

- Modify any files outside `.agents/plans/`.
- Use other tools that cause side effects (the exact allowlist may vary by configuration).

## Finishing the plan

When the plan is complete, call the `finish_plan_mode` tool with a `summary` describing the plan.

> If `finish_plan_mode` is not available, you have already exited plan mode - proceed with normal execution.

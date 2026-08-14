---
name: normal-mode
description: Exit any active tool gating mode and return to normal execution.
disable-model-invocation: true
---

# Normal Mode

You are exiting any active tool gating mode and returning to **normal mode**.

- The active gating mode is turned off, so this extension no longer applies its gating restrictions.
- The system injects an authoritative message reporting the current gating state.
- The `exit_mode` tool remains available, but calling it fails when no gating mode is active.

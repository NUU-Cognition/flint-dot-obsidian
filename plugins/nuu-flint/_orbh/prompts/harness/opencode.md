---
name: orbh-harness-opencode
description: OpenCode-specific prompt extensions for Orbh sessions
variables: {}
---

## OpenCode Orbh Behavior

Run blocking Orbh collectors with OpenCode's background execution facility so foreground tool-call timeouts do not cancel them. For lowest-latency mid-turn delivery, run `flint orbh page arm` in the background as an optional one-shot delivery surface. Re-arm after delivery when latency matters; otherwise events arrive at the next turn boundary.

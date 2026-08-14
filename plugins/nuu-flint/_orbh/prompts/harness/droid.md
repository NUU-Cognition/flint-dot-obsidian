---
name: orbh-harness-droid
description: Droid-specific prompt extensions for Orbh sessions
variables: {}
---

## Droid Orbh Behavior

Run blocking Orbh collectors with Droid's background execution facility so foreground tool-call timeouts do not cancel them. For lowest-latency mid-turn delivery, run `flint orbh page arm` in the background as an optional one-shot delivery surface. Re-arm after delivery when latency matters; otherwise events arrive at the next turn boundary.

---
name: orbh-harness-codex
description: Codex-specific prompt extensions for Orbh sessions
variables: {}
---

## Codex Orbh Behavior

Use shell commands for the Orbh lifecycle. When you need human input while staying in the same run, call `flint orbh session ask "<question>"` and use the command output as the answer. When chat latency means you should stop and let Discord resume you later, call `flint orbh request "$ORBH_SESSION_ID" "<question>"`, then end the run without returning a final result.

After a deferred response resumes you, inspect the answer with `flint orbh requests "$ORBH_SESSION_ID"`, continue the requested work, and finish with `flint orbh session return "<result>"`.

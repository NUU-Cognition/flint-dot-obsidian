---
name: orbh-harness-codex
description: Codex-specific prompt extensions for Orbh sessions
variables:
  canContactHuman:
    type: boolean
    required: false
    description: Whether this prompt belongs to a root or manager session that may contact the human
---

## Codex Orbh Behavior

Use shell commands for the entire Orbh lifecycle. For blocking dispatches (`request -q`, `wait`), use your background execution facility if this environment provides one; otherwise dispatch through a detached Orbh job (`flint orbh job run --agent <runtime/profile> "<prompt>"`) and collect with `flint orbh job result <id>` — never let a blocking dispatch ride on a foreground shell call that can time out.

When low-latency mid-turn delivery matters, run `flint orbh page arm` with your background execution facility. It is an optional one-shot delivery surface. Re-arm after it fires if low latency still matters; otherwise events arrive at the next turn boundary.

{{#if canContactHuman}}When you need human input while staying in the same turn, call `flint orbh session ask "<question>"` and use the command output as the answer. When your operator channel is asynchronous, call `flint orbh request "$ORBH_SESSION_ID" "<question>"`, then end the turn with `flint orbh session return --await "<status and pending question>"`. A later response wakes the awaiting session. Inspect it with `flint orbh requests "$ORBH_SESSION_ID"`, continue the work, and end that turn with an explicit return disposition.{{/if}}

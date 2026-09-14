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

Managed delivery takes priority over the shell pager rules below. Run `flint orbh page status` first. If the reason is `harness-connection`, the manager owns delivery. Do not start or retain a shell pager. A `held` connection resumes after `compact finish`. If delivery is `uncertain`, inspect the exact event with `flint orbh page recover <event-id>`. Handle that Page before you use `--acknowledge`. If `page arm` reports managed delivery, no background task is required. Use the shell pager rules only when no harness connection exists.

Use shell commands for the entire Orbh lifecycle. For blocking dispatches (`request -q`, `wait`), use your background execution facility if this environment provides one; otherwise dispatch through a detached Orbh job (`flint orbh job run --agent <runtime/profile> "<prompt>"`) and collect with `flint orbh job result <id>` — never let a blocking dispatch ride on a foreground shell call that can time out.

For an interactive session, arm `flint orbh page arm` during bootstrap through your background execution facility. Keep the task identifier and check its output at work boundaries and before each final reply. Re-arm after it delivers a Page. Background execution does not guarantee a completion notification. Follow the application's pager check and compaction rules.

Call `exec_command` with `{"cmd":"flint orbh page arm","yield_time_ms":1000,"max_output_tokens":2000}`. Keep the returned `session_id`. Collect output with `write_stdin` using that identifier, empty `chars`, and `yield_time_ms: 1000`. The identifier belongs to the shell task; do not pass it to an Orbh command. If the tools are exposed through `functions.exec`, call them through `tools` and return their results with `text(...)`.

For an unattended session, the pager is optional. Arm it when you need delivery during the current turn. The orchestrator owns wake delivery between unattended turns.

{{#if canContactHuman}}When you need human input while staying in the same turn, call `flint orbh session ask "<question>"` and use the command output as the answer. When your operator channel is asynchronous, call `flint orbh request "$ORBH_SESSION_ID" "<question>"`, then end the turn with `flint orbh session return --await "<status and pending question>"`. A later response wakes the awaiting session. Inspect it with `flint orbh requests "$ORBH_SESSION_ID"`, continue the work, and end that turn with an explicit return disposition.{{/if}}

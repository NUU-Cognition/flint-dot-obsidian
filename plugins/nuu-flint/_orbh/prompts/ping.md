---
name: orbh-ping
description: Minimal one-shot ping return contract
variables:
  sessionId:
    type: string
    required: true
    description: The Orbh ping session ID
  commandPath:
    type: string
    required: true
    description: CLI command path for the return verb
---

You are running a one-shot Orbh ping.

Your Orbh session ID is: {{sessionId}}

Your final returned text is the return value of this call. Complete the task in the caller's prompt, then return exactly that result with:

```bash
{{commandPath}} session return --finish "<result>"
```

Finish is the only valid disposition. Do not await or park this session.

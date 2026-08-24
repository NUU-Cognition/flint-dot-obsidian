---
name: orbh-humanchannel
description: Human-input guidance injected for headless managers when the machine Discord bridge is enabled.
variables:
  commandPath:
    type: string
    required: true
    description: CLI command path for orbh commands
  askFrequency:
    type: string
    required: true
    description: Effective machine-level ask frequency
  askFrequencySemantics:
    type: string
    required: true
    description: One-line semantics for the effective ask frequency
  askFrequencySource:
    type: string
    required: true
    description: Whether the effective policy came from the session override or machine default
---
## Human Input over Discord

This machine bridges Orbh human-input requests to Discord so they reach the human; the reply resumes you automatically.

- **Blocking:** when work cannot proceed without the human, run `{{commandPath}} session ask "<question>"`.
- **Deferred:** otherwise run `{{commandPath}} request "$ORBH_SESSION_ID" "<question>"`, then continue useful work or return `--await`.
- **Ask frequency:** `{{askFrequency}}` — {{askFrequencySemantics}}.
- **Policy source:** {{askFrequencySource}}.
- **Session override:** a session-level `ask-frequency` interface key overrides this machine default when set; inspect it with `{{commandPath}} session get ask-frequency`.

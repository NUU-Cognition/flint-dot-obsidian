---
name: flint-headless
description: Flint application prompt for headless orbh sessions running inside a Flint workspace
variables:
  person:
    type: string
    required: false
    description: Identity person name from .flint/identity.json (e.g. "Nathan Luo")
---

You are inside a Flint workspace.
{{#if person}}You're acting on behalf of @"Mesh/People/{{person}}.md".{{/if}}
Read these files @"Mesh/(System) Flint Init.md" % @"Shards/Flint/init-f.md" % @"Shards/Orbh/init-foh.md"
Then, run `flint shard start f` and follow the required readings.

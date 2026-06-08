# Obsidian Patch Registry

This folder contains intentional local patches that can be re-applied after a reset, new-machine clone, plugin update, or upstream overwrite.

Each patch lives in its own numbered folder:

```text
patches/<NNN-slug>/patch.json
```

## Descriptor Format

Every `patch.json` includes:

```json
{
  "id": "001-example",
  "title": "Human-readable patch title",
  "why": "Why this patch exists and when it should be reapplied.",
  "target": "relative/path/under/.obsidian.json",
  "type": "json-set",
  "platforms": ["darwin"],
  "changes": [
    {
      "path": ["some", "json", "key"],
      "value": true
    }
  ]
}
```

Required fields:

- `id`: stable patch id, normally matching the folder name.
- `title`: short human-readable name.
- `why`: reason for the patch; include the upstream limitation or local policy.
- `target`: relative path under `.obsidian/`. Absolute paths and `..` are invalid.
- `type`: either `json-set` or `file-overlay`.
- `platforms`: supported Node platforms, such as `darwin` or `win32`; use `all` only for platform-independent patches.

## Patch Types

`json-set` patches set or merge JSON values in tracked Obsidian config files such as `hotkeys.json` or `plugins/*/data.json`.

```json
{
  "type": "json-set",
  "target": "hotkeys.json",
  "changes": [
    {
      "path": ["terminal:open-terminal.integrated.root"],
      "value": [{ "modifiers": ["Alt", "Ctrl"], "key": "T" }]
    }
  ]
}
```

Each change supports:

- `path`: JSON path as an array of object keys or array indexes.
- `value`: JSON value to write.
- `mode`: optional, `set` by default. Use `merge` to deep-merge object values while preserving sibling keys.

`file-overlay` patches replace or ensure a whole file. The payload is stored beside the descriptor:

```json
{
  "type": "file-overlay",
  "target": "snippets/example.css",
  "payload": "example.css"
}
```

## Applying

Use:

```bash
flint obsidian patches list
flint obsidian patches apply
flint obsidian profiles
flint obsidian profiles apply default
flint obsidian profiles apply baseline-transparent
```

When Obsidian is open, the CLI routes the apply through the NUU Flint plugin runtime API so hotkeys and appearance settings are written through Obsidian's in-memory config. When Obsidian is closed, the CLI writes files directly.

Profiles live under `profiles/<NNN-slug>/profile.json` and list patch ids in the order they should apply. The `default` profile only hides the left ribbon. Use other profiles for optional reusable changes such as `baseline-transparent`; keep `patches apply` for low-level repair/reapply of every documented patch.

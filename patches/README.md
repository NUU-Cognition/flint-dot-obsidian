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
- `type`: one of `json-set`, `file-overlay`, or `text-replace`.
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

`text-replace` patches make in-place string edits to a non-JSON file — chiefly a plugin's
minified `main.js` where there is no setting or config key to drive the change. Each replacement
finds an exact anchor and substitutes it. This is preferred over `file-overlay` for plugin
bundles because it edits only the patched region and survives plugin updates: a fresh `main.js`
still contains the `find` anchors, so the edit re-applies cleanly instead of pinning the whole
file to a frozen version.

```json
{
  "type": "text-replace",
  "target": "plugins/terminal/main.js",
  "replacements": [
    { "find": "getDisplayText(){return this.context...}", "replace": "getDisplayText(){return this.name}" }
  ]
}
```

Each replacement supports:

- `find`: exact substring anchor that exists in the unpatched file.
- `replace`: text to substitute for every occurrence of `find`.

`text-replace` is idempotent: a replacement whose `replace` text is already present is treated as
done and skipped, so re-applying is a no-op. If neither the `find` anchor nor the `replace` result
is present (the upstream file changed shape), apply fails loudly rather than corrupting the file —
re-derive the anchor and update the patch.

## Terminal patches

The Polyipseity terminal plugin carries two independent patch units:

- `001-terminal-hotkey-binding` (`json-set` → `hotkeys.json`) — binds the new-terminal command to
  Alt+Ctrl+T.
- `003-terminal-main-js` (`text-replace` → `plugins/terminal/main.js`) — the plugin's own code
  edits that have no settings: (1) hotkey passthrough, so tab-switch / new-terminal / settings /
  zen-mode hotkeys still reach Obsidian while a terminal pane is focused instead of falling through
  to the shell, and (2) stripping the `Terminal: ` tab-title prefix. Reapply after any terminal
  plugin update.

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

Profiles live under `profiles/<NNN-slug>/profile.json` and list patch ids in the order they should apply. The `default` profile hides the left ribbon, keeps window translucency off, and enables the terminal color fix. Use other profiles for optional reusable changes such as `baseline-transparent`; keep `patches apply` for low-level repair/reapply of every documented patch.

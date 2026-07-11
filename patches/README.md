# The Patch Log

This folder is a **log of intentional edits to plugin bundles** — code changes to files like `plugins/*/main.js` that have no settings exposure. Every entry is already **baked into the committed tree**: on a healthy checkout you never need to apply anything. The log exists so the edits can be **replayed** when a plugin update ships a fresh bundle and clobbers them — a dev/maintainer operation, not part of normal vault use.

This is one of two mechanisms for intentional local changes. The other is **profiles** (`../profiles/`) — activatable, *reversible*, per-vault choices such as appearance. The split:

| | Patch log (`patches/`) | Profiles (`../profiles/`) |
|---|---|---|
| What | Code edits to plugin bundles | Per-vault config choices (appearance, etc.) |
| Lives in git? | Yes — effects are committed | No — targets are untracked per-vault files |
| Lifecycle | Permanent; replayed after plugin updates | Activate / deactivate at will |
| Reversible? | No — they *are* the canonical state | Yes — activation stashes prior values |
| Who runs it | Dev, after updating a plugin | Anyone, any time |

If you are about to add an appearance or config choice here: stop — that's a profile.

## Layout

Each log entry lives in its own numbered folder:

```text
patches/<NNN-slug>/patch.json
```

## Descriptor Format

```json
{
  "id": "003-example",
  "title": "Human-readable title",
  "why": "What the edit does and why it exists. Include the upstream limitation.",
  "target": "relative/path/under/.obsidian",
  "type": "text-replace",
  "platforms": ["darwin"],
  "replacements": [
    { "find": "original upstream text", "replace": "patched text" }
  ]
}
```

Required fields:

- `id`: stable entry id, normally matching the folder name.
- `title`: short human-readable name.
- `why`: reason for the edit; include the upstream limitation. This is the log's documentation value — write it well.
- `target`: relative path under `.obsidian/`. Absolute paths and `..` are invalid.
- `platforms`: Node platforms this entry applies on (`darwin`, `win32`), or `all`.
- `type`: one of `text-replace`, `json-set`, or `file-overlay` (see below).

## The Anchor-on-Original Rule

**Every replacement anchors on original upstream text and produces its final form directly.** No entry may anchor on another entry's output. This keeps every entry independently derivable from a fresh plugin bundle, which is what makes replay order-independent and lets each entry's status be checked in isolation. If two edits touch the same region, the later entry owns that region end-to-end and the earlier entry drops it.

## Entry Types

`text-replace` is the normal type for plugin bundles — in-place string edits to a minified `main.js` where no setting exists. Each replacement finds an exact anchor and substitutes it:

```json
{
  "type": "text-replace",
  "target": "plugins/terminal/main.js",
  "replacements": [
    { "find": "getDisplayText(){return this.context...}", "replace": "getDisplayText(){return this.name}" }
  ]
}
```

`text-replace` is idempotent: a replacement whose `replace` text is already present is treated as done and skipped, so replaying over an already-patched tree is a no-op. If neither the `find` anchor nor the `replace` result is present, the upstream file changed shape — replay fails loudly rather than corrupting the file; re-derive the anchor from the new bundle and update the entry.

`json-set` (set/merge JSON values) and `file-overlay` (replace a whole file, payload stored beside the descriptor) are also supported, but tracked JSON config belongs directly in git and per-vault config belongs in profiles — so log entries of these types should be rare.

## Current Entries

Both target the Polyipseity terminal plugin's `main.js` and are independent of each other:

- `003-terminal-main-js` — (1) hotkey passthrough: whitelist tab-switch / new-terminal / settings / zen-mode command ids so they reach Obsidian while a terminal is focused; (2) focus-on-activate: switching to a terminal pane moves keyboard focus into the xterm input, guarded by `document.hasFocus()`. (The Alt+Ctrl+T binding itself lives in the tracked `hotkeys.json` — tracked config needs no log entry.)
- `004-terminal-icon` — status-driven tab icons: `getIcon()` returns runtime brand icons (nuu-claude / nuu-codex / nuu-grok, with `-busy` variants keyed off the leading spinner glyph in the pane title; plain shells keep the stock terminal icon); `getDisplayText()` strips the status glyph/runtime label so runtime tabs show the topic only, and plain (no-runtime) tabs always show the fixed label `Terminal`.

After updating the terminal plugin, replay and reload.

## CLI

```bash
flint obsidian patches list      # is every entry still baked in?
flint obsidian patches replay    # dev repair: re-derive entries onto fresh bundles
```

`list` shows whether each entry's effect is present in the working files. `replay` writes the entries back (idempotent, order-independent) and reloads Obsidian if it is open. Profiles have their own verbs:

```bash
flint obsidian profiles list
flint obsidian profiles activate <id>
flint obsidian profiles deactivate
```

Profile activation stashes the prior values of exactly what it changes into the untracked `.obsidian/.profile-state.json`; deactivation restores them. See `../profiles/`.

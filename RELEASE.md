# Release

A payload release is the tag `v<version>` on `main` (decision D3). The tag names one commit, and `manifest.json` in that commit gives the manifest digest. The flint CLI recommends a release in `packages/flint/src/obsidian/recommendation.json`. A Flint pins a release in `flint.json#obsidian`.

## Release flow

| # | Step | Check |
|---|---|---|
| 1 | For a plugin change: build the plugin in the flint repository. Then run `node scripts/import-plugin.mjs <build dir> <flint commit>` here, or `node apps/nuu-flint-plugin/scripts/deploy.mjs --payload <this folder>` in the flint repository. | `release.json` records the plugin version, the source commit, and the control protocol of that commit. |
| 2 | Edit `payload/`, `settings/`, `profiles/`, `migrations/`, `applied.json`, or `patches/`. Then run `node scripts/build.mjs`. | `node scripts/check.mjs` |
| 3 | Test on macOS and on Linux: run `flint obsidian dev install <this folder>` in a closed test Flint. The version of the Flint CLI must be in `release.json#cli`. | `flint obsidian status` shows `dev`. |
| 4 | Run `node scripts/release.mjs <version>`. It sets the version, builds the manifest, runs the checks in release mode, and commits `release.json` and `manifest.json`. It does not tag and does not push. | `check.mjs --release` passes. |
| 5 | Run the tag and push commands that `release.mjs` prints: `git tag -a v<version> -m "Obsidian payload <version>" <commit>`, then `git push origin main v<version>`. | Payload CI runs `node scripts/check.mjs --release --fetch` on the tag. |
| 6 | In the flint repository, make sure that the version of `apps/flint-cli` is in `release.json#cli`. Bump it first when it is not: `pnpm obsidian:recommend` refuses a CLI version outside the range. Then run `pnpm obsidian:recommend v<version>`. It writes `recommendation.json`. | The flint release check `070-obsidian-payload` |
| 7 | Ship the CLI. | — |
| 8 | Canary: run `flint obsidian update` in one Flint. Then run `flint obsidian update --tinderbox`. | A result and a backup id for each member |

A change of `release.json#cli` needs a new payload release, because the range is part of the tagged commit. So bump the CLI, not the range.

A release never changes a settings file that a person has. To change existing vaults, add a settings migration in `migrations/`.

## The 0.7.0 release cut

The branch `obs-0.7.0` holds the 0.7.0 layout. These items are open. Do them in this order:

1. **Import the 0.7.0 plugin build (WP6).** Build `apps/nuu-flint-plugin` at a clean integration commit. Then run `node apps/nuu-flint-plugin/scripts/deploy.mjs --payload <this folder>` in the flint repository (it runs `scripts/import-plugin.mjs`). The build must contain the CSS under "Moved to plugin styles" below, and the command `nuu-flint:launch-orbh-interactive-default` (`hotkeys.json` binds it). Commit `payload/plugins/nuu-flint`, `release.json`, and `manifest.json`. Until this step, `release.json` has `plugin.version` `0.0.1` (the 0.6.x bundle) and `plugin.sourceCommit` `pending`: `check.mjs` warns four times, and `check.mjs --release` fails.
2. **Bump the Flint CLI to `0.7.0`** in the flint repository (the manager does it at the release cut). `release.json#cli` is `>=0.7.0 <0.8.0`. The dev install, the live checks, and `pnpm obsidian:recommend` refuse a CLI version outside this range.
3. **Merge `obs-0.7.0` into `main`.**
4. **Remove the `share-note` key from the history (Report 083 §15).**
   1. Save a local bundle of the old history: `git bundle create ../flint-dot-obsidian-before-0.7.0.bundle --all`.
   2. On a mirror clone, run `git filter-repo --path plugins/share-note/data.json --invert-paths`.
   3. Verify that no commit and no blob holds the key: `git log --all --oneline -- plugins/share-note/data.json` prints nothing, and `git log --all -p | grep -cF '<the old key>'` prints `0`. Read the old key from the bundle of step 1 (`git show bdcaa09:plugins/share-note/data.json`). Do not search with a pattern of the key form: this file quotes such a pattern, so the search finds this line.
   4. Force-push every branch.
   The rewrite changes every commit id. So do it before the tag.
5. **Cut the release.** Run `node scripts/release.mjs 0.7.0`. Then run the tag and push commands that it prints.
6. **Recommend the release** in the flint repository: `pnpm obsidian:recommend v0.7.0`. Then commit `packages/flint/src/obsidian/recommendation.json`.
7. **Rotate the Share Note key** at Share Note. GitHub can serve old commits for some time after the rewrite.

## What 0.7.0 changed in the payload source

Retired files: `plugins/nuu-flint-helper/` (its reload command moves into `nuu-flint`), `plugins/nuu-flint/_flint/`, `_orbh/`, and `presets/` (the plugin stops bundling CLI prompts and presets), `snippets/terminal-status-icon.css` (the CSS moves into the plugin styles), `profiles/default/` (the initial `appearance.json` and the release layer carry `showRibbon: false`), `themes/Omarchy/` (a runtime file: Omarchy writes it), `flint-obsidian.json` (`release.json`, the pin, and the installed state replace it), `patches/README.md` (this README replaces it), `.DS_Store`, `plugins/.DS_Store`, and `plugins/terminal/data.json.bak-m004`.

Sanitised initial settings:
- `plugins/nuu-flint/data.json` is `{}`. Removed: `defaultOrbhProfile` (`claude/o47h`, a personal choice), `preferredPort` (`13040`, no longer a setting), and `hideLeftRibbon` (`true`; `appearance.json#showRibbon` owns the ribbon).
- `plugins/vertical-tabs/data.json`: removed `installationID`.
- `plugins/terminal/data.json`: removed the profiles `win32ExternalDefault` and `win32IntegratedDefault`, every `useWin32Conhost`, and `"win32": false` in `darwinExternalDefault`. One variant for each platform.
- `hotkeys.json`: renamed `nuu-obsidian:launch-orbh-interactive-default` to `nuu-flint:launch-orbh-interactive-default` (`Mod+N`). Removed `tab-selector:open-tab-selector` (`Ctrl+1`; the plugin is not in the payload). Removed `insert-current-date` (`Mod+Shift+M`) and `insert-current-time` (`Mod+Shift+N`): core Templates is off, and Templater has no matching command.
- `core-plugins.json`: `templates` is off. Templater is the one template engine.
- `community-plugins.json`: does not enable `obsidian-git`, `share-note`, or `nuu-flint-helper`. The payload still ships the `obsidian-git` and `share-note` bundles (decision D5).
- `workspaces.json`: one generic `Split` layout. Removed the `Power` layout, the `Mesh/Homepage.md` leaf, and the backlink note path `Mesh/Archive/Notepads/(Notepad) 035 Notepad Shard Improvements.md`. The Homepage still opens `Split` and a terminal at startup.
- New `appearance.json`: `{ "showRibbon": false, "enabledCssSnippets": ["vertical-tabs-numbers", "checkbox-dim-not-strike"] }`.
- `snippets/baseline-extension-font.css`: removed the two Google Fonts imports. It now declares Geist and Geist Mono from the fonts that are installed on the machine.

## Moved to plugin styles

0.7.0 removes `snippets/terminal-status-icon.css`. The NUU Flint plugin (WP6) puts this CSS into its `styles.css`, so that every vault gets the tab status icons, the spinner, and the turn timer with no snippet. This is the content of the retired snippet at `d92885e`:

```css
/*
 * terminal-status-icon
 *
 * The patched terminal getIcon() keeps the runtime BRAND logo on the left at all
 * times (svg class `nuu-claude` / `nuu-codex` / `nuu-grok`), swapping to the identical-artwork
 * `*-busy` variant while the runtime is working. This snippet reads that class
 * via :has() and renders a status indicator on the RIGHT of the tab:
 *   - working   → a spinning ring
 *   - idle/done → a static dot
 * Both occupy the SAME fixed-size slot so their centers line up (the dot is just
 * drawn smaller inside it). The brand icon is never replaced; the pin is hidden.
 *
 * Turn timer: displayed from a `data-nuu-turn` attribute on `.tree-item-inner`
 * (set by a JS timer — dormant/empty until that's wired). It is styled and
 * vertically centered here so it just lights up once the attribute is fed.
 *
 * No plugin bundle is touched (survives plugin updates).
 */
@keyframes nuu-terminal-icon-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Animated integer counters for the pure-CSS mm:ss turn timer (interim, until a
   JS timer feeds data-nuu-turn). Resets to 0:00 each time a tab enters `-busy`. */
@property --nuu-m {
  syntax: "<integer>";
  initial-value: 0;
  inherits: false;
}
@property --nuu-s {
  syntax: "<integer>";
  initial-value: 0;
  inherits: false;
}
@keyframes nuu-count-m {
  to {
    --nuu-m: 100;
  }
}
@keyframes nuu-count-s {
  to {
    --nuu-s: 60;
  }
}

/* Hide the pin button in the sidebar — the status indicator owns the right slot. */
.obsidian-vertical-tabs-container .tree-item.is-tab .action-pin {
  display: none !important;
}

/* ---------------- Vertical Tabs sidebar ---------------- */

/* Positioning context + base right room for the dot/ring slot. */
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon[class*="nuu-claude"]),
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon[class*="nuu-codex"]),
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon[class*="nuu-grok"]) {
  position: relative;
}
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon[class*="nuu-claude"])
  .tree-item-inner,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon[class*="nuu-codex"])
  .tree-item-inner,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon[class*="nuu-grok"])
  .tree-item-inner {
  padding-right: 1.6em;
}
/* Extra room when a turn timer is shown — while working (CSS timer) or when a
   JS timer feeds data-nuu-turn. */
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-claude-busy)
  .tree-item-inner,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-codex-busy)
  .tree-item-inner,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-grok-busy)
  .tree-item-inner,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self
  .tree-item-inner[data-nuu-turn]:not([data-nuu-turn=""]) {
  padding-right: 4.2em;
}

/* Shared status slot — a fixed 0.82em box anchored at the right edge. Both the
   idle dot and the working ring fill this box, so their centers coincide. */
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-claude)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-codex)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-grok)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-claude-busy)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-codex-busy)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-grok-busy)::after {
  content: "";
  box-sizing: border-box;
  position: absolute;
  right: var(--size-4-3);
  top: 50%;
  width: 0.82em;
  height: 0.82em;
  margin-top: -0.41em;
  border-radius: 50%;
  pointer-events: none;
}

/* Idle/done → white dot drawn centered inside the slot. */
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-claude)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-codex)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-grok)::after {
  background: radial-gradient(circle, #fff 0.205em, transparent 0.215em);
}

/* Working → spinning white ring filling the slot. */
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-claude-busy)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-codex-busy)::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-grok-busy)::after {
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  animation: nuu-terminal-icon-spin 0.8s linear infinite;
}

/* Turn timer (interim pure-CSS): while working, a mm:ss counter that resets to
   0:00 each turn. Vertically centered, just left of the status ring. */
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-claude-busy)
  .tree-item-inner::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-codex-busy)
  .tree-item-inner::after,
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self:has(.tree-item-icon .svg-icon.nuu-grok-busy)
  .tree-item-inner::after {
  counter-reset: nuum var(--nuu-m) nuus var(--nuu-s);
  content: counter(nuum) ":" counter(nuus, decimal-leading-zero);
  position: absolute;
  right: calc(var(--size-4-3) + 1.5em);
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  line-height: 1;
  font-size: var(--font-ui-smaller);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  animation: nuu-count-m 6000s steps(100) forwards, nuu-count-s 60s steps(60) infinite;
  pointer-events: none;
}

/* When a JS timer feeds data-nuu-turn, it wins (persists across turns). */
.obsidian-vertical-tabs-container
  .tree-item.is-tab:not(.is-tab-slot)
  .tree-item-self
  .tree-item-inner[data-nuu-turn]:not([data-nuu-turn=""])::after {
  counter-reset: none !important;
  content: attr(data-nuu-turn) !important;
  animation: none !important;
  position: absolute;
  right: calc(var(--size-4-3) + 1.5em);
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  line-height: 1;
  font-size: var(--font-ui-smaller);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  pointer-events: none;
}

/* ---------------- Core tab header (top tabs) ---------------- */

.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-claude)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-codex)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-grok)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-claude-busy)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-codex-busy)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-grok-busy)
  .workspace-tab-header-inner::after {
  content: "";
  box-sizing: border-box;
  width: 0.82em;
  height: 0.82em;
  margin-left: var(--size-2-2);
  border-radius: 50%;
  flex: 0 0 auto;
  align-self: center;
  pointer-events: none;
}
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-claude)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-codex)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-grok)
  .workspace-tab-header-inner::after {
  background: radial-gradient(circle, #fff 0.205em, transparent 0.215em);
}
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-claude-busy)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-codex-busy)
  .workspace-tab-header-inner::after,
.workspace-tab-header:has(.workspace-tab-header-inner-icon .svg-icon.nuu-grok-busy)
  .workspace-tab-header-inner::after {
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  animation: nuu-terminal-icon-spin 0.8s linear infinite;
}
```

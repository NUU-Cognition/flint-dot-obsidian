#!/usr/bin/env node
// Run every check of the payload source (Report 083 §11.3) that this repository owns.
//
// Usage: node scripts/check.mjs [--release] [--fetch]
//   --release  A warning that blocks a release is a failure (release.mjs uses it).
//   --fetch    Also download each upstream plugin and verify it against upstream/lock.json.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPLIED_KEYS, appliedEntryProblem, buildManifest, cliRangeProblem, compare, inventory, isCommit, isDigestHex, isMain,
  isPointer, isVersion, MIGRATION_ID, MIGRATION_OPS, NUU_PLUGIN, NUU_PLUGIN_FILES, obsidianInstallForm, PATCH_ID, PLATFORMS,
  PROFILE_ID, PROFILE_KEYS, readPatches, replay, replayPatches, resolveSettings, RETIRED_PATHS, ROOT, satisfiesCliRange,
  sha256, toJson, unsafePathReason,
} from './lib.mjs';

/** Command namespaces of the Obsidian app itself (not a core plugin). */
const APP_NAMESPACES = new Set(['app', 'editor', 'workspace', 'markdown', 'theme', 'window', 'open-with-default-app']);
/** Core-plugin commands whose id has no prefix. */
const CORE_UNPREFIXED = { 'insert-template': 'templates', 'insert-current-date': 'templates', 'insert-current-time': 'templates' };
/** Settings keys that hold a personal or retired value. */
const PERSONAL_KEYS = new Set(['defaultOrbhProfile', 'preferredPort', 'hideLeftRibbon', 'installationID']);
const SECRET_KEY = /^(?:.*api[-_]?key|.*secret|.*password|passwd|.*token|uid|account[-_]?id|user[-_]?id|installation[-_]?id|license[-_]?key)$/i;
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, 'a GitHub token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/, 'an API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'a Google API key'],
];
const MACHINE_PATH = /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\/|\b[A-Za-z]:\\\\?Users\\\\?/;
const NOTE_PATH = /\.(?:md|canvas|base|excalidraw)(?:#.*)?$/i;
/** Folders and files whose text the hygiene check scans. upstream/ holds unpatched third-party files. */
/** The files of the release formats. They follow the general rules of the formats. */
const FORMAT_FILE = (e) => ['release.json', 'applied.json', 'upstream/lock.json'].includes(e.path) || ['profile', 'migration', 'patch'].includes(e.class);
/** The next command for a plugin bundle that is not the 0.7.x build. */
const IMPORT_NEXT = 'node scripts/import-plugin.mjs <flint repo>/apps/nuu-flint-plugin <flint commit>';
const SCANNED = (path) => /^(?:payload|settings|profiles|migrations|patches|docs)\//.test(path) || ['applied.json', 'release.json', 'README.md', 'RELEASE.md'].includes(path);

export async function runChecks(root = ROOT, { release = false, fetch: online = false } = {}) {
  const results = [];
  const run = async (name, title, fn) => {
    const r = { name, title, fail: [], warn: [], note: [] };
    const ctx = {
      fail: (text, next) => r.fail.push({ text, next }),
      warn: (text, next, { blocksRelease = false } = {}) => (release && blocksRelease ? r.fail : r.warn).push({ text, next }),
      note: (text) => r.note.push(text),
    };
    try {
      await fn(ctx);
    } catch (error) {
      ctx.fail(error.message, error.next);
    }
    results.push(r);
  };

  const { entries, problems } = inventory(root);
  const jsonCache = new Map();
  const json = (path) => {
    if (!jsonCache.has(path)) jsonCache.set(path, JSON.parse(readFileSync(join(root, path), 'utf8')));
    return jsonCache.get(path);
  };
  const text = (path) => readFileSync(join(root, path), 'utf8');
  const plugins = readPayloadPlugins(root);
  const snippets = new Set(entries.filter((e) => e.class === 'release' && e.dest.startsWith('snippets/')).map((e) => e.dest.slice(9, -4)));
  const themes = new Set(entries.filter((e) => e.class === 'release' && /^themes\/[^/]+\/theme\.css$/.test(e.dest)).map((e) => e.dest.split('/')[1]));

  await run('inventory', 'every path has one class', (c) => {
    for (const p of problems) if (p.kind !== 'junk') c.fail(p.text, 'move the file to the folder of its class, or delete it');
    for (const path of RETIRED_PATHS) if (existsSync(join(root, path))) c.fail(`${path}: 0.7.0 retired this path`, `git rm -r "${path}"`);
    const owners = new Map();
    for (const e of entries.filter((x) => x.class === 'release' || x.class === 'settings')) {
      const owner = owners.get(e.dest);
      if (owner && owner.class !== e.class) c.fail(`.obsidian/${e.dest} has two owners: ${owner.path} and ${e.path}`, 'keep one of the two files');
      else if (!owner) owners.set(e.dest, e);
    }
    for (const [id, plugin] of plugins) {
      if (plugin.manifest?.id !== id) c.fail(`payload/plugins/${id}/manifest.json: the id is "${plugin.manifest?.id}", not "${id}"`, 'rename the folder to the plugin id');
      if (!plugin.files.includes('main.js')) c.fail(`payload/plugins/${id}/main.js is missing`, 'copy the plugin bundle into the folder');
    }
    for (const platform of PLATFORMS) {
      const seen = new Map();
      for (const dest of [...entries.filter((x) => x.class === 'release').map((x) => x.dest), ...resolveSettings(entries, platform).keys()]) {
        const fold = dest.toLowerCase();
        if (seen.has(fold) && seen.get(fold) !== dest) c.fail(`.obsidian/${dest} and .obsidian/${seen.get(fold)} differ only in letter case (${platform})`, 'rename one of the two files');
        else seen.set(fold, dest);
      }
    }
    const nuu = plugins.get(NUU_PLUGIN);
    if (!nuu) c.fail(`payload/plugins/${NUU_PLUGIN}/ is missing`, 'node scripts/import-plugin.mjs <build dir> <flint commit>');
    else for (const f of nuu.files) if (!NUU_PLUGIN_FILES.includes(f)) c.fail(`payload/plugins/${NUU_PLUGIN}/${f}: the NUU Flint plugin ships only ${NUU_PLUGIN_FILES.join(', ')}`, `git rm -r "payload/plugins/${NUU_PLUGIN}/${f}"`);
    const themeDir = join(root, 'payload/themes');
    for (const theme of existsSync(themeDir) ? readdirSync(themeDir) : []) {
      for (const f of ['manifest.json', 'theme.css']) if (!existsSync(join(root, 'payload/themes', theme, f))) c.fail(`payload/themes/${theme}/${f} is missing`, 'add the file, or remove the theme');
    }
    const counts = {};
    for (const e of entries) counts[e.class] = (counts[e.class] ?? 0) + 1;
    c.note(`${entries.length} paths: ${Object.entries(counts).sort(([a], [b]) => compare(a, b)).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  });

  await run('hygiene', 'no junk, secrets, ids, machine paths, or note paths', (c) => {
    for (const p of problems) if (p.kind === 'junk') c.fail(p.text, `rm "${p.path}"  (on macOS: find . -name .DS_Store -delete)`);
    let scanned = 0;
    for (const e of entries.filter((x) => SCANNED(x.path))) {
      const body = text(e.path);
      scanned++;
      for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(body)) c.fail(`${e.path} holds what looks like ${label}`, 'remove the value, and rotate it if it is real');
      const machine = MACHINE_PATH.exec(body);
      if (machine) c.fail(`${e.path} holds a machine path (${machine[0]})`, 'use a path relative to the vault, or remove the value');
    }
    for (const e of entries.filter((x) => x.class === 'settings' || (x.path.startsWith('docs/') && /\.json/.test(x.path)))) {
      walkJson(json(e.path), '', (pointer, key, value) => {
        if (PERSONAL_KEYS.has(key)) c.fail(`${e.path}${pointer}: a personal or retired key`, `delete the key "${key}"`);
        else if (SECRET_KEY.test(key) && typeof value === 'string' && value !== '') c.fail(`${e.path}${pointer}: a secret or an account id`, `set the value to "" or delete the key "${key}"`);
        if (e.class === 'settings' && typeof value === 'string' && NOTE_PATH.test(value)) c.fail(`${e.path}${pointer}: a note path ("${value}")`, 'initial settings name no note; remove the value');
      });
    }
    c.note(`${scanned} files scanned`);
  });

  await run('replay', 'upstream/ plus patches/ equals the released bundle', async (c) => {
    const lock = json('upstream/lock.json');
    if (lock.schema !== 1) c.fail(`upstream/lock.json: ${schemaProblem(lock.schema)}`, 'fix upstream/lock.json');
    if (!isObject(lock.plugins)) c.fail('upstream/lock.json: "plugins" must be an object of plugin records', 'fix upstream/lock.json');
    if (Object.hasOwn(lock.plugins ?? {}, NUU_PLUGIN)) c.fail(`upstream/lock.json: "${NUU_PLUGIN}" is not a third-party plugin`, `remove "${NUU_PLUGIN}" from the lock`);
    for (const [id, plugin] of plugins) {
      if (id === NUU_PLUGIN) continue;
      const entry = lock.plugins?.[id];
      if (!entry) { c.fail(`payload/plugins/${id}: no entry in upstream/lock.json`, `add "${id}" with its version, release asset URL, and unpatched sha256`); continue; }
      if (entry.version !== plugin.manifest?.version) c.fail(`upstream/lock.json: "${id}" is ${entry.version}, but the payload bundle is ${plugin.manifest?.version}`, 'update the lock entry and upstream/ together with the bundle');
      if (!/^https:\/\//.test(entry.source ?? '')) c.fail(`upstream/lock.json: "${id}" has no https source URL`, 'add the URL of the release asset');
      if (!isObject(entry.files) || !Object.keys(entry.files).length) c.fail(`upstream/lock.json: "${id}" has no "files"`, 'add the sha256 of the unpatched main.js');
      for (const [file, hex] of Object.entries(entry.files ?? {})) if (!isDigestHex(hex)) c.fail(`upstream/lock.json: "${id}" ${file} has no sha256`, 'add the sha256 of the unpatched file');
    }
    for (const id of Object.keys(lock.plugins ?? {})) if (id !== NUU_PLUGIN && !plugins.has(id)) c.fail(`upstream/lock.json: "${id}" is not in payload/plugins/`, `remove "${id}" from the lock`);
    for (const e of entries.filter((x) => x.class === 'upstream' && x.plugin)) {
      if (!lock.plugins?.[e.plugin]?.files?.[e.file]) c.fail(`${e.path}: no matching entry in upstream/lock.json`, 'add the file to the lock, or delete it');
    }
    const patches = readPatches(root, entries);
    const groups = new Map();
    for (const p of patches) {
      const bad = patchFormatProblem(p, lock);
      if (bad) { c.fail(`${p._path}: ${bad}`, 'fix the patch entry (see README.md, "The patch log")'); continue; }
      const key = `${p.plugin}/${p.file}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const e of entries.filter((x) => x.class === 'upstream' && x.plugin)) {
      const key = `${e.plugin}/${e.file}`;
      if (!groups.has(key)) groups.set(key, []);
    }
    for (const [key, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
      const [plugin, file] = key.split('/');
      const target = `payload/plugins/${plugin}/${file}`;
      const got = replay(root, lock, plugin, file, group);
      if (!existsSync(join(root, target))) { c.fail(`${target} is missing`, 'restore the released bundle'); continue; }
      if (!got.equals(readFileSync(join(root, target)))) c.fail(`${target} does not equal upstream/${key} plus ${group.length} patch entries`, `update the patch entries, or rebuild ${target} from the replay`);
      else c.note(`${key}: ${group.length} patch entries replay byte for byte`);
    }
    if (online) {
      for (const [id, entry] of Object.entries(lock.plugins ?? {}).sort(([a], [b]) => compare(a, b))) {
        const response = await fetch(entry.source);
        if (!response.ok) { c.fail(`${id}: ${entry.source} answered ${response.status}`, 'fix the source URL in upstream/lock.json'); continue; }
        const body = Buffer.from(await response.arrayBuffer());
        if (sha256(body) !== entry.files['main.js']) { c.fail(`${id}: the downloaded main.js does not match upstream/lock.json`, 'check the version and the source URL'); continue; }
        const own = groups.get(`${id}/main.js`) ?? [];
        const expected = Buffer.from(obsidianInstallForm(replayPatches(body.toString('utf8'), own)), 'utf8');
        if (!expected.equals(readFileSync(join(root, `payload/plugins/${id}/main.js`)))) c.fail(`payload/plugins/${id}/main.js does not equal its upstream release in the Obsidian install form`, 'copy the bundle again from the upstream release');
      }
      c.note(`${Object.keys(lock.plugins ?? {}).length} upstream releases downloaded and verified`);
    } else {
      c.note('the upstream releases were not downloaded (use --fetch)');
    }
  });

  await run('settings', 'JSON parses; plugins, hotkeys, snippets, and themes exist', (c) => {
    for (const e of entries.filter((x) => x.path.endsWith('.json'))) {
      try { json(e.path); } catch (error) { c.fail(`${e.path}: invalid JSON (${error.message})`, 'fix the JSON syntax'); }
    }
    for (const e of entries.filter(FORMAT_FILE)) {
      const body = text(e.path);
      if (!body.endsWith('\n')) c.fail(`${e.path}: the file must end with a newline`, 'add a newline at the end of the file');
      if (/^\t/m.test(body)) c.fail(`${e.path}: indent with 2 spaces, not tabs`, 'format the file with a 2-space indent');
    }
    const applied = safe(() => json('applied.json'), {});
    const core = safe(() => json('settings/common/core-plugins.json'), {});
    const live = (id) => commandProblem(id, core, plugins);
    for (const platform of PLATFORMS) {
      const resolved = resolveSettings(entries, platform);
      const get = (dest) => (resolved.has(dest) ? safe(() => json(resolved.get(dest)), undefined) : undefined);
      const at = (dest) => `${resolved.get(dest) ?? dest} (${platform})`;
      const enabled = get('community-plugins.json') ?? [];
      if (!Array.isArray(enabled)) c.fail(`${at('community-plugins.json')}: expected a list of plugin ids`, 'fix the file');
      else for (const id of enabled) if (!plugins.has(id)) c.fail(`${at('community-plugins.json')}: "${id}" is enabled, but payload/plugins/${id}/ does not exist`, `remove "${id}" from the list`);
      for (const [id] of Object.entries(get('hotkeys.json') ?? {})) {
        const why = live(id);
        if (why) c.fail(`${at('hotkeys.json')}: dead hotkey "${id}" (${why})`, `remove "${id}", or bind the command that replaces it`);
      }
      const appearance = get('appearance.json') ?? {};
      for (const name of appearance.enabledCssSnippets ?? []) if (!snippets.has(name)) c.fail(`${at('appearance.json')}: the snippet "${name}" does not exist`, `add payload/snippets/${name}.css, or remove the name`);
      if (appearance.cssTheme && !themes.has(appearance.cssTheme)) c.fail(`${at('appearance.json')}: the theme "${appearance.cssTheme}" does not exist`, `add payload/themes/${appearance.cssTheme}/, or remove the value`);
      for (const [dest] of resolved) {
        const m = /^plugins\/([^/]+)\/data\.json$/.exec(dest);
        if (m && !plugins.has(m[1])) c.fail(`${at(dest)}: settings for a plugin that is not in payload/plugins/`, `delete ${resolved.get(dest)}`);
      }
      const homepage = get('plugins/homepage/data.json');
      const workspaces = get('workspaces.json')?.workspaces ?? {};
      for (const [name, page] of Object.entries(homepage?.homepages ?? {})) {
        if (page.kind === 'Workspace' && !(page.value in workspaces)) c.fail(`${at('plugins/homepage/data.json')}: "${name}" opens the workspace "${page.value}", which workspaces.json does not have`, 'add the workspace, or change the homepage');
        for (const command of page.commands ?? []) {
          const why = live(command.id);
          if (why) c.fail(`${at('plugins/homepage/data.json')}: "${name}" runs the dead command "${command.id}" (${why})`, 'remove the command');
        }
      }
    }
    for (const e of entries.filter((x) => x.class === 'profile')) {
      for (const problem of profileProblems(json(e.path), e.id, snippets, themes, applied)) c.fail(`${e.path}: ${problem}`, 'fix the appearance profile (see README.md)');
    }
    for (const problem of appliedProblems(applied, snippets, themes)) c.fail(`applied.json: ${problem}`, 'fix the release layer (see README.md)');
    const migrations = entries.filter((x) => x.class === 'migration');
    for (const e of migrations) for (const problem of migrationProblems(json(e.path), e.id)) c.fail(`${e.path}: ${problem}`, 'fix the settings migration (see README.md)');
    c.note(`${PLATFORMS.join(' and ')} resolved · ${migrations.length} settings migrations · ${entries.filter((x) => x.class === 'profile').length} appearance profile(s)`);
  });

  await run('linux-default', 'each platform selects its own terminal profile without patch 005', (c) => {
    for (const platform of PLATFORMS) {
      const path = resolveSettings(entries, platform).get('plugins/terminal/data.json');
      if (!path) { c.fail(`no terminal settings for ${platform}`, `add settings/${platform}/plugins/terminal/data.json`); continue; }
      const data = json(path);
      const profile = data.profiles?.[data.defaultProfile];
      if (!profile) c.fail(`${path}: defaultProfile "${data.defaultProfile}" is not in profiles`, 'set defaultProfile to a profile id');
      else if (profile.type !== 'integrated' || profile.platforms?.[platform] !== true) c.fail(`${path}: defaultProfile "${data.defaultProfile}" is not an integrated ${platform} profile`, `set defaultProfile to the integrated ${platform} profile`);
      else c.note(`${platform}: ${data.defaultProfile} (${[profile.executable, ...(profile.args ?? [])].join(' ')})`);
    }
  });

  await run('manifest', 'manifest.json is current', (c) => {
    const want = toJson(buildManifest(root));
    const have = existsSync(join(root, 'manifest.json')) ? readFileSync(join(root, 'manifest.json'), 'utf8') : '';
    if (want !== have) c.fail('manifest.json does not match the source tree', 'node scripts/build.mjs');
    else c.note(`digest sha256:${sha256(Buffer.from(have, 'utf8'))}`);
  });

  await run('release', 'release.json agrees with the NUU Flint plugin', (c) => {
    const r = json('release.json');
    const blocks = { blocksRelease: true };
    if (r.schema !== 1) c.fail(`release.json: ${schemaProblem(r.schema)}`, 'fix release.json');
    if (!isVersion(r.version)) c.fail(`release.json: version "${r.version}" is not a version`, 'node scripts/release.mjs <version>');
    const cliBad = cliRangeProblem(r.cli);
    if (cliBad) c.fail(`release.json: cli ${JSON.stringify(r.cli)} is not a comparator range (${cliBad})`, 'use comparator sets joined by "||", for example ">=0.7.0 <0.8.0"');
    if (!Number.isInteger(r.protocol) || r.protocol < 1) c.fail('release.json: "protocol" must be the control protocol number', 'set "protocol" to OBSIDIAN_CONTROL_PROTOCOL, or import the plugin again');
    if (!Array.isArray(r.obsidian?.tested) || !r.obsidian.tested.length || !r.obsidian.tested.every(isVersion)) c.fail('release.json: "obsidian.tested" must list the tested Obsidian versions', 'add the Obsidian versions of the live checks');
    const plugin = plugins.get(NUU_PLUGIN);
    if (r.plugin?.id !== NUU_PLUGIN) c.fail(`release.json: plugin.id must be "${NUU_PLUGIN}"`, 'fix release.json');
    if (!isVersion(r.plugin?.version)) c.fail(`release.json: plugin.version "${r.plugin?.version}" is not a version`, IMPORT_NEXT);
    if (plugin && r.plugin?.version !== plugin.manifest?.version) c.fail(`release.json: plugin.version is "${r.plugin?.version}", but the bundle is ${plugin.manifest?.version}`, IMPORT_NEXT);
    const versions = safe(() => json(`payload/plugins/${NUU_PLUGIN}/versions.json`), {});
    if (plugin && !(plugin.manifest?.version in versions)) c.fail(`payload/plugins/${NUU_PLUGIN}/versions.json has no entry for ${plugin.manifest?.version}`, 'import a plugin build whose versions.json lists its version');
    // A 0.6.x plugin build must never reach a release (Report 083 D6, finding PAY-1).
    if (!cliBad && isVersion(r.plugin?.version) && !satisfiesCliRange(r.plugin.version, r.cli)) c.warn(`release.json: the NUU Flint plugin ${r.plugin.version} is outside the CLI range ${r.cli}; the bundle comes from another CLI line`, IMPORT_NEXT, blocks);
    if (plugin && r.protocol >= 2) {
      const bundle = plugin.bundle();
      if (!bundle.includes('describe-manager')) c.warn(`payload/plugins/${NUU_PLUGIN}/main.js has no describe-manager operation, so it does not serve control protocol ${r.protocol} (a 0.6.x build)`, IMPORT_NEXT, blocks);
      if (bundle.includes('trust-vault')) c.warn(`payload/plugins/${NUU_PLUGIN}/main.js still has the retired trust-vault operation (a 0.6.x build)`, IMPORT_NEXT, blocks);
    }
    if (r.plugin?.sourceCommit === 'pending') c.warn('release.json: plugin.sourceCommit is "pending"', IMPORT_NEXT, blocks);
    else if (!isCommit(r.plugin?.sourceCommit)) c.fail(`release.json: plugin.sourceCommit "${r.plugin?.sourceCommit}" is not a full commit id`, IMPORT_NEXT);
    c.note(`release ${r.version} · cli ${r.cli} · protocol ${r.protocol} · ${NUU_PLUGIN} ${r.plugin?.version} (${r.plugin?.sourceCommit})`);
  });

  return results;
}

/** The plugins of payload/plugins/: id → { manifest, files, bundle() }. */
function readPayloadPlugins(root) {
  const out = new Map();
  const dir = join(root, 'payload/plugins');
  if (!existsSync(dir)) return out;
  for (const id of readdirSync(dir).sort(compare)) {
    const files = readdirSync(join(dir, id)).sort(compare);
    let bundle;
    out.set(id, {
      files,
      manifest: safe(() => JSON.parse(readFileSync(join(dir, id, 'manifest.json'), 'utf8')), null),
      bundle: () => (bundle ??= safe(() => readFileSync(join(dir, id, 'main.js'), 'utf8'), '')),
    });
  }
  return out;
}

/** Why a command id is dead, or null when it is live. */
export function commandProblem(id, core, plugins) {
  const colon = id.indexOf(':');
  if (colon < 0) {
    const owner = CORE_UNPREFIXED[id];
    if (!owner) return 'unknown command id';
    return core[owner] === true ? null : `the core plugin "${owner}" is off`;
  }
  const prefix = id.slice(0, colon);
  const command = id.slice(colon + 1);
  if (APP_NAMESPACES.has(prefix)) return null;
  if (prefix in core) return core[prefix] === true ? null : `the core plugin "${prefix}" is off`;
  const plugin = plugins.get(prefix);
  if (!plugin) return `no plugin "${prefix}" in payload/plugins/`;
  if (!plugin.bundle().includes(command)) return `the bundle of "${prefix}" has no command "${command}"`;
  return null;
}

function patchFormatProblem(p, lock) {
  if (p.schema !== 1) return schemaProblem(p.schema);
  if (typeof p.id !== 'string' || !PATCH_ID.test(p.id)) return `the id ${JSON.stringify(p.id)} does not match ${PATCH_ID.source}`;
  if (p.id !== p._folder) return `the id "${p.id}" does not match the folder "${p._folder}"`;
  if (typeof p.title !== 'string' || !p.title.trim() || typeof p.why !== 'string' || !p.why.trim()) return '"title" and "why" must be non-empty strings';
  if (p.plugin === NUU_PLUGIN) return `the patch log edits third-party bundles only, not "${NUU_PLUGIN}"`;
  if (!lock.plugins?.[p.plugin]) return `the plugin "${p.plugin}" is not in upstream/lock.json`;
  if (!lock.plugins[p.plugin].files?.[p.file]) return `upstream/lock.json has no file "${p.file}" for "${p.plugin}"`;
  if (!Array.isArray(p.replacements) || !p.replacements.length) return '"replacements" must be a non-empty list';
  for (const r of p.replacements) {
    if (typeof r.find !== 'string' || typeof r.replace !== 'string' || !r.find) return 'each replacement needs the strings "find" and "replace"';
    if (r.find === r.replace) return 'a replacement changes nothing';
  }
  const extra = Object.keys(p).filter((k) => !k.startsWith('_') && !['schema', 'id', 'title', 'why', 'plugin', 'file', 'replacements'].includes(k));
  if (extra.length) return `unknown fields: ${extra.join(', ')}`;
  return null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaProblem(schema) {
  return typeof schema === 'number' && schema > 1 ? `"schema" is ${schema}: a newer payload format wrote the file` : '"schema" must be 1';
}

function referenceProblems(key, op, snippets, themes) {
  const out = [];
  if (key === 'enabledCssSnippets') for (const name of [...(op.add ?? []), ...(Array.isArray(op.set) ? op.set : [])]) if (!snippets.has(name)) out.push(`the snippet "${name}" does not exist`);
  if (key === 'cssTheme' && typeof op.set === 'string' && op.set && !themes.has(op.set)) out.push(`the theme "${op.set}" does not exist`);
  return out;
}

const platformsProblem = (platforms) => (!Array.isArray(platforms) || !platforms.length || platforms.some((x) => !PLATFORMS.includes(x)) ? `"platforms" must list one or more of ${PLATFORMS.join(', ')}` : null);

/** The rules of `parseProfileDefinition` in the core, and decision S12. `applied` is the release layer. */
export function profileProblems(p, folder, snippets, themes, applied = {}) {
  if (!isObject(p)) return ['the profile is not a JSON object'];
  const out = [];
  if (p.schema !== 1) out.push(schemaProblem(p.schema));
  if (typeof p.id !== 'string' || !PROFILE_ID.test(p.id)) out.push(`the id ${JSON.stringify(p.id)} does not match ${PROFILE_ID.source}`);
  else if (p.id !== folder) out.push(`the id "${p.id}" does not match the folder "${folder}"`);
  if (typeof p.title !== 'string' || !p.title.trim()) out.push('"title" must be a non-empty string');
  if (typeof p.description !== 'string' || !p.description.trim()) out.push('"description" must be a non-empty string');
  const platforms = platformsProblem(p.platforms);
  if (platforms) out.push(platforms);
  if (!isObject(p.set)) return [...out, '"set" must be an object with the file "appearance"'];
  for (const file of Object.keys(p.set)) if (file !== 'appearance') out.push(`an appearance profile sets only "appearance" keys, not "${file}"`);
  const appearance = p.set.appearance;
  if (!isObject(appearance) || !Object.keys(appearance).length) return [...out, '"set.appearance" must name at least one key'];
  for (const [key, op] of Object.entries(appearance)) {
    if (!PROFILE_KEYS.includes(key)) { out.push(`"${key}" is not an appearance profile key (${PROFILE_KEYS.join(', ')})`); continue; }
    const bad = appliedEntryProblem('appearance', key, op);
    if (bad) { out.push(bad); continue; }
    if ('remove' in op) out.push(`appearance.${key}: a profile adds list members and never removes them (decision S12)`);
    if (isObject(applied?.appearance) && Object.hasOwn(applied.appearance, key)) out.push(`appearance.${key}: applied.json holds this key, so each activation of the profile refuses (decision S12)`);
    out.push(...referenceProblems(key, op, snippets, themes));
  }
  return out;
}

/** The release layer: `appearance` and `app` are required; each entry follows `OBSIDIAN_APPLIED_KEYS`. */
export function appliedProblems(a, snippets, themes) {
  if (!isObject(a)) return ['applied.json is not a JSON object'];
  const out = [];
  if (a.schema !== 1) out.push(schemaProblem(a.schema));
  for (const file of Object.keys(APPLIED_KEYS)) if (!isObject(a[file])) out.push(`"${file}" must be an object of keys (it can be empty)`);
  for (const file of Object.keys(a)) {
    if (file === 'schema') continue;
    if (!(file in APPLIED_KEYS)) { out.push(`"${file}" is not an applied file (${Object.keys(APPLIED_KEYS).join(', ')})`); continue; }
    if (!isObject(a[file])) continue;
    for (const [key, op] of Object.entries(a[file])) {
      const bad = appliedEntryProblem(file, key, op);
      if (bad) out.push(bad);
      else if (file === 'appearance') out.push(...referenceProblems(key, op, snippets, themes));
    }
  }
  return out;
}

/** The rules of `parseSettingsMigration` and `isMigrationOperation` in the core. */
export function migrationProblems(m, id) {
  if (!isObject(m)) return ['the migration is not a JSON object'];
  const out = [];
  if (m.schema !== 1) out.push(schemaProblem(m.schema));
  if (typeof m.id !== 'string' || !MIGRATION_ID.test(m.id)) out.push(`the id ${JSON.stringify(m.id)} does not match ${MIGRATION_ID.source}, so the ids do not sort in run order`);
  else if (m.id !== id) out.push(`the id "${m.id}" does not match the file name "${id}"`);
  if (typeof m.description !== 'string' || !m.description.trim()) out.push('"description" must be a non-empty string');
  if (typeof m.file !== 'string' || unsafePathReason(m.file) || !/^(?:[^/]+\.json|plugins\/[^/]+\/data\.json)$/.test(m.file)) out.push('"file" must be a settings file path (<name>.json or plugins/<id>/data.json)');
  const platforms = platformsProblem(m.platforms);
  if (platforms) out.push(platforms);
  if (!Array.isArray(m.operations) || !m.operations.length) return [...out, '"operations" must be a non-empty list'];
  for (const [i, op] of m.operations.entries()) {
    const at = `operation ${i + 1}`;
    if (!isObject(op)) { out.push(`${at}: an operation is an object`); continue; }
    const fields = MIGRATION_OPS[op.op];
    if (!fields) { out.push(`${at}: unknown op ${JSON.stringify(op.op)} (${Object.keys(MIGRATION_OPS).join(', ')})`); continue; }
    for (const f of fields) if (!(f in op)) out.push(`${at}: "${op.op}" needs "${f}"`);
    for (const f of op.op === 'rename-key' ? ['from', 'to'] : ['key']) if (f in op && !isPointer(op[f])) out.push(`${at}: "${f}" must be a JSON Pointer ("" or "/…")`);
    if ('members' in op && (!Array.isArray(op.members) || !op.members.length || op.members.some((x) => typeof x !== 'string'))) out.push(`${at}: "members" must be a non-empty list of strings`);
    const extra = Object.keys(op).filter((k) => k !== 'op' && !fields.includes(k) && !(op.op === 'remove-key' && k === 'ifEquals'));
    if (extra.length) out.push(`${at}: unknown fields ${extra.join(', ')}`);
  }
  return out;
}

function walkJson(value, pointer, visit) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const next = `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (!Array.isArray(value)) visit(next, key, child);
    else if (typeof child === 'string') visit(next, '', child);
    walkJson(child, next, visit);
  }
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

export function render(results, { release = false, version = '' } = {}) {
  const lines = [];
  lines.push(`Payload source check${version ? ` · release ${version}` : ''}${release ? ' · release mode' : ''}`);
  for (const r of results) {
    const mark = r.fail.length ? '✖' : r.warn.length ? '⚠' : '✔';
    lines.push(`  ${mark} ${r.name.padEnd(13)} ${r.title}`);
    for (const n of r.note) lines.push(`      ${n}`);
    for (const f of r.fail) lines.push(`      ✖ ${f.text}${f.next ? `\n        Next: ${f.next}` : ''}`);
    for (const w of r.warn) lines.push(`      ⚠ ${w.text}${w.next ? `\n        Next: ${w.next}` : ''}`);
  }
  const failed = results.filter((r) => r.fail.length).length;
  const warnings = results.reduce((n, r) => n + r.warn.length, 0);
  lines.push(failed ? `Result: ${failed} check(s) failed.` : `Result: passed${warnings ? ` with ${warnings} warning(s)` : ''}.`);
  return { text: lines.join('\n'), failed };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--release' && a !== '--fetch');
  if (unknown.length) {
    console.error(`✖ Unknown option: ${unknown.join(' ')}\n  Next: node scripts/check.mjs [--release] [--fetch]`);
    process.exit(1);
  }
  const options = { release: args.includes('--release'), fetch: args.includes('--fetch') };
  const version = safe(() => JSON.parse(readFileSync(join(ROOT, 'release.json'), 'utf8')).version, '');
  const { text, failed } = render(await runChecks(ROOT, options), { ...options, version });
  console.log(text);
  process.exit(failed ? 1 : 0);
}

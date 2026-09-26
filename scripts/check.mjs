#!/usr/bin/env node
// Run every check of the payload source (Report 083 §11.3) that this repository owns.
//
// Usage: node scripts/check.mjs [--release] [--fetch]
//   --release  A warning that blocks a release is a failure (release.mjs uses it).
//   --fetch    Also download each upstream plugin and verify it against upstream/lock.json.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPLIED_KEYS, applyPatches, buildManifest, compare, inventory, isCommit, isDigestHex, isMain,
  isPointer, isSemver, LIST_KEYS, MIGRATION_OPS, NUU_PLUGIN, NUU_PLUGIN_FILES, obsidianInstallForm, PLATFORMS,
  PROFILE_KEYS, readPatches, replay, resolveSettings, RETIRED_PATHS, ROOT, sha256, toJson,
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
    if (lock.schema !== 1 || typeof lock.plugins !== 'object') c.fail('upstream/lock.json: expected { "schema": 1, "plugins": { … } }', 'fix upstream/lock.json');
    for (const [id, plugin] of plugins) {
      if (id === NUU_PLUGIN) continue;
      const entry = lock.plugins?.[id];
      if (!entry) { c.fail(`payload/plugins/${id}: no entry in upstream/lock.json`, `add "${id}" with its version, release asset URL, and unpatched sha256`); continue; }
      if (entry.version !== plugin.manifest?.version) c.fail(`upstream/lock.json: "${id}" is ${entry.version}, but the payload bundle is ${plugin.manifest?.version}`, 'update the lock entry and upstream/ together with the bundle');
      if (!/^https:\/\//.test(entry.source ?? '')) c.fail(`upstream/lock.json: "${id}" has no https source URL`, 'add the URL of the release asset');
      for (const [file, hex] of Object.entries(entry.files ?? {})) if (!isDigestHex(hex)) c.fail(`upstream/lock.json: "${id}" ${file} has no sha256`, 'add the sha256 of the unpatched file');
    }
    for (const id of Object.keys(lock.plugins ?? {})) if (!plugins.has(id)) c.fail(`upstream/lock.json: "${id}" is not in payload/plugins/`, `remove "${id}" from the lock`);
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
        const expected = Buffer.from(obsidianInstallForm(applyPatches(body.toString('utf8'), own)), 'utf8');
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
      for (const problem of profileProblems(json(e.path), e.id, snippets, themes)) c.fail(`${e.path}: ${problem}`, 'fix the appearance profile (see README.md)');
    }
    for (const problem of appliedProblems(json('applied.json'), snippets, themes)) c.fail(`applied.json: ${problem}`, 'fix the release layer (see README.md)');
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
    if (r.schema !== 1) c.fail('release.json: "schema" must be 1', 'fix release.json');
    if (!isSemver(r.version)) c.fail(`release.json: version "${r.version}" is not a semantic version`, 'node scripts/release.mjs <version>');
    if (typeof r.cli !== 'string' || !r.cli.trim()) c.fail('release.json: "cli" must name the compatible CLI range', 'set "cli", for example ">=0.7.0 <0.8.0"');
    if (!Number.isInteger(r.protocol) || r.protocol < 1) c.fail('release.json: "protocol" must be the control protocol number', 'set "protocol" to OBSIDIAN_CONTROL_PROTOCOL');
    if (!Array.isArray(r.obsidian?.tested) || !r.obsidian.tested.length) c.fail('release.json: "obsidian.tested" must list the tested Obsidian versions', 'add the versions of the live checks');
    const plugin = plugins.get(NUU_PLUGIN);
    if (r.plugin?.id !== NUU_PLUGIN) c.fail(`release.json: plugin.id must be "${NUU_PLUGIN}"`, 'fix release.json');
    if (plugin && r.plugin?.version !== plugin.manifest?.version) c.fail(`release.json: plugin.version is "${r.plugin?.version}", but the bundle is ${plugin.manifest?.version}`, 'node scripts/import-plugin.mjs <build dir> <flint commit>');
    const versions = safe(() => json(`payload/plugins/${NUU_PLUGIN}/versions.json`), {});
    if (plugin && !(plugin.manifest?.version in versions)) c.fail(`payload/plugins/${NUU_PLUGIN}/versions.json has no entry for ${plugin.manifest?.version}`, 'import a plugin build whose versions.json lists its version');
    if (r.plugin?.sourceCommit === 'pending') c.warn('release.json: plugin.sourceCommit is "pending"', 'node scripts/import-plugin.mjs <build dir> <flint commit>', { blocksRelease: true });
    else if (!isCommit(r.plugin?.sourceCommit)) c.fail(`release.json: plugin.sourceCommit "${r.plugin?.sourceCommit}" is not a full commit id`, 'node scripts/import-plugin.mjs <build dir> <flint commit>');
    c.note(`release ${r.version} · protocol ${r.protocol} · ${NUU_PLUGIN} ${r.plugin?.version} (${r.plugin?.sourceCommit})`);
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
  if (p.schema !== 1) return '"schema" must be 1';
  if (p.id !== p._folder) return `the id "${p.id}" does not match the folder "${p._folder}"`;
  if (!p.title || !p.why) return '"title" and "why" are required';
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

/** Problems of one appliable operation: `{ set }` or `{ add, remove }` for a list key. */
function opProblem(key, op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return `${key}: an operation is { "set": … } or { "add": [ … ], "remove": [ … ] }`;
  const keys = Object.keys(op);
  if (keys.length === 1 && keys[0] === 'set') return null;
  if (keys.length && keys.every((k) => k === 'add' || k === 'remove')) {
    if (!LIST_KEYS.has(key)) return `${key}: "add" and "remove" apply only to a list key`;
    if (keys.some((k) => !Array.isArray(op[k]) || op[k].some((m) => typeof m !== 'string'))) return `${key}: "add" and "remove" take lists of strings`;
    return null;
  }
  return `${key}: unknown operation fields ${keys.join(', ')}`;
}

function referenceProblems(key, op, snippets, themes) {
  const out = [];
  if (key === 'enabledCssSnippets') for (const name of [...(op.add ?? []), ...(Array.isArray(op.set) ? op.set : [])]) if (!snippets.has(name)) out.push(`the snippet "${name}" does not exist`);
  if (key === 'cssTheme' && typeof op.set === 'string' && op.set && !themes.has(op.set)) out.push(`the theme "${op.set}" does not exist`);
  return out;
}

export function profileProblems(p, folder, snippets, themes) {
  const out = [];
  if (p.schema !== 1) out.push('"schema" must be 1');
  if (p.id !== folder) out.push(`the id "${p.id}" does not match the folder "${folder}"`);
  if (!p.title || !p.description) out.push('"title" and "description" are required');
  if (!Array.isArray(p.platforms) || !p.platforms.length || p.platforms.some((x) => !PLATFORMS.includes(x))) out.push(`"platforms" must list one or more of ${PLATFORMS.join(', ')}`);
  const files = Object.keys(p.set ?? {});
  if (!files.length) out.push('"set" is empty');
  for (const file of files) {
    if (file !== 'appearance') { out.push(`an appearance profile sets only "appearance" keys, not "${file}"`); continue; }
    for (const [key, op] of Object.entries(p.set[file])) {
      if (!PROFILE_KEYS.includes(key)) { out.push(`"${key}" is not an appearance profile key (${PROFILE_KEYS.join(', ')})`); continue; }
      const bad = opProblem(key, op);
      if (bad) out.push(bad);
      else out.push(...referenceProblems(key, op, snippets, themes));
    }
  }
  return out;
}

export function appliedProblems(a, snippets, themes) {
  const out = [];
  if (a.schema !== 1) out.push('"schema" must be 1');
  for (const file of Object.keys(a)) {
    if (file === 'schema') continue;
    if (!(file in APPLIED_KEYS)) { out.push(`"${file}" is not an applied file (${Object.keys(APPLIED_KEYS).join(', ')})`); continue; }
    if (!a[file] || typeof a[file] !== 'object' || Array.isArray(a[file])) { out.push(`"${file}" must be an object of keys`); continue; }
    for (const [key, op] of Object.entries(a[file])) {
      const allowed = APPLIED_KEYS[file];
      if (allowed && !allowed.includes(key)) { out.push(`"${file}.${key}" is not an allowed applied key`); continue; }
      const bad = opProblem(key, op);
      if (bad) out.push(`${file}.${bad}`);
      else if (file === 'appearance') out.push(...referenceProblems(key, op, snippets, themes));
    }
  }
  return out;
}

export function migrationProblems(m, id) {
  const out = [];
  if (m.schema !== 1) out.push('"schema" must be 1');
  if (m.id !== id) out.push(`the id "${m.id}" does not match the file name "${id}"`);
  if (!/^\d{4}-[a-z0-9-]+$/.test(id)) out.push('the id must be <4 digits>-<slug>, so that the ids sort in run order');
  if (!m.description) out.push('"description" is required');
  if (typeof m.file !== 'string' || !/^(?:[^/]+\.json|plugins\/[^/]+\/data\.json)$/.test(m.file)) out.push('"file" must be a settings file path');
  if (!Array.isArray(m.platforms) || !m.platforms.length || m.platforms.some((x) => !PLATFORMS.includes(x))) out.push(`"platforms" must list one or more of ${PLATFORMS.join(', ')}`);
  if (!Array.isArray(m.operations) || !m.operations.length) out.push('"operations" must be a non-empty list');
  for (const [i, op] of (m.operations ?? []).entries()) {
    const fields = MIGRATION_OPS[op.op];
    if (!fields) { out.push(`operation ${i + 1}: unknown op "${op.op}" (${Object.keys(MIGRATION_OPS).join(', ')})`); continue; }
    for (const f of fields) if (!(f in op)) out.push(`operation ${i + 1}: "${op.op}" needs "${f}"`);
    for (const f of op.op === 'rename-key' ? ['from', 'to'] : ['key']) if (f in op && !isPointer(op[f])) out.push(`operation ${i + 1}: "${f}" must be a JSON Pointer`);
    if ('members' in op && (!Array.isArray(op.members) || !op.members.length)) out.push(`operation ${i + 1}: "members" must be a non-empty list`);
    const extra = Object.keys(op).filter((k) => k !== 'op' && !fields.includes(k) && !(op.op === 'remove-key' && k === 'ifEquals'));
    if (extra.length) out.push(`operation ${i + 1}: unknown fields ${extra.join(', ')}`);
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

// Shared code for the scripts of the payload source. Node 24 or later, no dependencies.
//
// Terms follow the glossary of Report 083: release file, settings file, runtime file,
// initial settings, settings migration, applied settings, appearance profile, patch log.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PLATFORMS = ['darwin', 'linux'];
export const SETTINGS_LAYERS = ['common', ...PLATFORMS];
export const NUU_PLUGIN = 'nuu-flint';
/** The files that `import-plugin.mjs` copies. The NUU Flint plugin folder holds nothing else. */
export const NUU_PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css', 'versions.json'];

/** Obsidian's community-plugin installer appends this trailer to each main.js that it downloads. */
export const INSTALL_TRAILER = '\n/* nosourcemap */';

/** Keys that an appearance profile can set (Report 083 §8). */
export const PROFILE_KEYS = ['cssTheme', 'translucency', 'enabledCssSnippets', 'showRibbon', 'accentColor', 'baseFontSize'];
/** Keys of applied settings. `app` has no list yet: the spec (WP2) lists its keys. */
export const APPLIED_KEYS = {
  appearance: ['cssTheme', 'theme', 'translucency', 'enabledCssSnippets', 'showRibbon', 'accentColor', 'baseFontSize', 'interfaceFontFamily', 'textFontFamily', 'monospaceFontFamily'],
  app: null,
};
export const LIST_KEYS = new Set(['enabledCssSnippets']);
export const MIGRATION_OPS = {
  'add-if-absent': ['key', 'value'],
  'rename-key': ['from', 'to'],
  'remove-key': ['key'],
  'set-if-equals': ['key', 'from', 'to'],
  'list-add': ['key', 'members'],
  'list-remove': ['key', 'members'],
};

/** Paths that 0.7.0 retired. They must not come back. */
export const RETIRED_PATHS = [
  'flint-obsidian.json',
  'payload/plugins/nuu-flint-helper',
  'payload/plugins/nuu-flint/_flint',
  'payload/plugins/nuu-flint/_orbh',
  'payload/plugins/nuu-flint/presets',
  'payload/snippets/terminal-status-icon.css',
  'payload/themes/Omarchy',
  'profiles/default',
];
/** Runtime files. Obsidian, a plugin, or the desktop writes them; the payload never ships them. */
export const RUNTIME_FILES = ['workspace.json', 'workspace-mobile.json', 'graph.json', 'themes/Omarchy'];

const SOURCE_FILES = new Set(['README.md', 'RELEASE.md', 'release.json', 'manifest.json', 'package.json', '.gitignore']);
const SOURCE_DIRS = ['scripts/', 'docs/', '.github/'];
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** True when the module at `url` is the script that Node runs. */
export const isMain = (url) => Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === url;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

/** A problem that a script reports. `next` is the command or the edit that fixes it. */
export class PayloadError extends Error {
  constructor(message, next) {
    super(message);
    this.next = next;
  }
}

/**
 * Every entry of the source tree, with `/` separators, sorted by path.
 * `.git/` and `node_modules/` are skipped. A symbolic link is listed as a link and never followed.
 */
export function listTree(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort(compare)) {
      const path = rel ? `${rel}/${name}` : name;
      if (!rel && SKIP_DIRS.has(name)) continue;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) walk(path);
      else out.push({ path, kind: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'link' : 'other', mode: stat.isFile() && stat.mode & 0o111 ? '755' : '644', size: stat.size });
    }
  };
  walk('');
  return out.sort((a, b) => compare(a.path, b.path));
}

const SETTINGS_SHAPE = /^(?:[^/]+\.json|plugins\/[^/]+\/data\.json)$/;
const RELEASE_SHAPE = /^(?:plugins\/[^/]+\/[^/]+|snippets\/[^/]+\.css|themes\/[^/]+\/[^/]+)$/;

/**
 * The class of one source path, or `{ class: null, reason }`.
 * `dest` is the path under `.obsidian/` for release files and settings files.
 */
export function classify(path) {
  if (SOURCE_FILES.has(path) || SOURCE_DIRS.some((dir) => path.startsWith(dir))) return { class: 'source' };
  if (path === 'applied.json') return { class: 'applied' };
  let m;
  if ((m = /^payload\/(.+)$/.exec(path))) {
    const dest = m[1];
    if (/(^|\/)data\.json$/.test(dest)) return { class: null, reason: 'a data.json file is a settings file; move it to settings/' };
    if (isRuntime(dest)) return { class: null, reason: 'a runtime file; Obsidian writes it, so the payload never ships it' };
    if (!RELEASE_SHAPE.test(dest)) return { class: null, reason: 'a release file must be under plugins/<id>/, snippets/, or themes/<name>/' };
    return { class: 'release', dest };
  }
  if ((m = /^settings\/([^/]+)\/(.+)$/.exec(path))) {
    const [, layer, dest] = m;
    if (!SETTINGS_LAYERS.includes(layer)) return { class: null, reason: `unknown settings layer "${layer}" (use ${SETTINGS_LAYERS.join(', ')})` };
    if (isRuntime(dest)) return { class: null, reason: 'a runtime file; Obsidian writes it, so it has no initial settings' };
    if (!SETTINGS_SHAPE.test(dest)) return { class: null, reason: 'a settings file is <name>.json or plugins/<id>/data.json' };
    return { class: 'settings', layer, dest };
  }
  if ((m = /^profiles\/([^/]+)\/profile\.json$/.exec(path))) return { class: 'profile', id: m[1] };
  if ((m = /^migrations\/([^/]+)\.json$/.exec(path))) return { class: 'migration', id: m[1] };
  if ((m = /^patches\/([^/]+)\/patch\.json$/.exec(path))) return { class: 'patch', id: m[1] };
  if (path === 'upstream/lock.json') return { class: 'upstream' };
  if ((m = /^upstream\/([^/]+)\/([^/]+)$/.exec(path))) return { class: 'upstream', plugin: m[1], file: m[2] };
  return { class: null, reason: 'no class owns this path' };
}

function isRuntime(dest) {
  return RUNTIME_FILES.some((runtime) => dest === runtime || dest.startsWith(`${runtime}/`));
}

/** Junk that the source must never hold. */
export function junkReason(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini') return 'an operating system file';
  if (/\.bak/i.test(name) || /\.(orig|rej|swp)$/.test(name) || name.endsWith('~')) return 'a backup or editor file';
  return null;
}

/** A path segment check: no empty segment, no `.` or `..`, no backslash, no control character. */
export function unsafePathReason(path) {
  if (path.includes('\\')) return 'the path contains a backslash';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return 'the path contains a control character';
  if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'the path has an empty, "." or ".." segment';
  return null;
}

/**
 * The classified inventory of the tree. `problems` lists each path that no class owns,
 * each link, each junk file, and each unsafe path. `build.mjs` refuses a tree with problems.
 */
export function inventory(root) {
  const entries = [];
  const problems = [];
  const problem = (path, kind, reason) => problems.push({ path, kind, reason, text: `${path}: ${reason}` });
  for (const entry of listTree(root)) {
    const unsafe = unsafePathReason(entry.path);
    if (unsafe) { problem(entry.path, 'path', unsafe); continue; }
    if (entry.kind !== 'file') { problem(entry.path, 'path', `a ${entry.kind === 'link' ? 'symbolic link' : 'special file'}; the source holds plain files only`); continue; }
    const junk = junkReason(entry.path);
    if (junk) { problem(entry.path, 'junk', `${junk}; delete it`); continue; }
    const cls = classify(entry.path);
    if (!cls.class) { problem(entry.path, 'class', cls.reason); continue; }
    entries.push({ ...entry, ...cls });
  }
  return { entries, problems };
}

/** The manifest of the tree, as `formats.md` defines it. The bytes are stable for one tree. */
export function buildManifest(root) {
  const { entries, problems } = inventory(root);
  if (problems.length) throw new PayloadError(`The source tree has ${problems.length} inventory problem(s):\n  ${problems.map((p) => p.text).join('\n  ')}`, 'fix each path, then run: node scripts/build.mjs');
  const release = readJson(root, 'release.json').version;
  const hash = (path) => sha256(readFileSync(join(root, path)));
  const byPath = (a, b) => compare(a.path, b.path);
  const byId = (a, b) => compare(a.id, b.id);
  const settings = Object.fromEntries(SETTINGS_LAYERS.map((layer) => [layer, []]));
  const manifest = { schema: 1, release, files: [], settings, profiles: [], migrations: [], applied: null };
  for (const e of entries) {
    if (e.class === 'release') manifest.files.push({ path: e.dest, sha256: hash(e.path), mode: e.mode, size: e.size });
    else if (e.class === 'settings') settings[e.layer].push({ path: e.dest, sha256: hash(e.path) });
    else if (e.class === 'profile') manifest.profiles.push({ id: e.id, path: e.path, sha256: hash(e.path) });
    else if (e.class === 'migration') manifest.migrations.push({ id: e.id, path: e.path, sha256: hash(e.path) });
    else if (e.class === 'applied') manifest.applied = { path: e.path, sha256: hash(e.path) };
  }
  if (!manifest.applied) throw new PayloadError('applied.json is missing. The release layer of applied settings is required.', 'create applied.json with { "schema": 1, "appearance": {}, "app": {} }');
  manifest.files.sort(byPath);
  for (const layer of SETTINGS_LAYERS) settings[layer].sort(byPath);
  manifest.profiles.sort(byId);
  manifest.migrations.sort(byId);
  return manifest;
}

/** The initial settings of one platform: a platform file replaces the common file of the same path as a whole. */
export function resolveSettings(entries, platform) {
  const out = new Map();
  for (const layer of ['common', platform]) {
    for (const e of entries) if (e.class === 'settings' && e.layer === layer) out.set(e.dest, e.path);
  }
  return out;
}

/**
 * Apply patch entries to an unpatched upstream text. Each `find` anchors on the original
 * upstream text and must occur there exactly once. Edits must not overlap. So the result
 * does not depend on the order of the entries.
 */
export function applyPatches(upstream, patches) {
  const edits = [];
  for (const patch of patches) {
    for (const [i, r] of patch.replacements.entries()) {
      const at = upstream.indexOf(r.find);
      if (at < 0) throw new PayloadError(`${patch.id} replacement ${i + 1}: the anchor is not in the upstream file.`, `derive the anchor again from upstream/${patch.plugin}/${patch.file} and update patches/${patch.id}/patch.json`);
      if (upstream.indexOf(r.find, at + 1) >= 0) throw new PayloadError(`${patch.id} replacement ${i + 1}: the anchor occurs more than once in the upstream file.`, `make the anchor of patches/${patch.id}/patch.json longer, so that it is unique`);
      edits.push({ start: at, end: at + r.find.length, text: r.replace, label: `${patch.id} replacement ${i + 1}` });
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const edit of edits) {
    if (edit.start < pos) throw new PayloadError(`${edit.label} overlaps another replacement.`, 'give each region of the upstream file to one patch entry');
    out += upstream.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  return out + upstream.slice(pos);
}

/** The form in which Obsidian's installer writes a downloaded main.js: inline source maps removed, trailer added. */
export function obsidianInstallForm(text) {
  return text.replace(/\/\/# sourceMappingURL=data:[^\n]*/g, '') + INSTALL_TRAILER;
}

/** Read every patch entry of the source, sorted by id. */
export function readPatches(root, entries) {
  return entries
    .filter((e) => e.class === 'patch')
    .map((e) => ({ ...readJson(root, e.path), _path: e.path, _folder: e.id }))
    .sort((a, b) => compare(a.id, b.id));
}

/** Replay the patch log onto the stored upstream file. Returns the bytes that the payload must hold. */
export function replay(root, lock, plugin, file, patches) {
  const upstreamPath = `upstream/${plugin}/${file}`;
  if (!existsSync(join(root, upstreamPath))) throw new PayloadError(`${upstreamPath} is missing. The replay needs the unpatched file.`, `download ${lock?.plugins?.[plugin]?.source ?? 'the upstream release asset'} to ${upstreamPath}`);
  const bytes = readFileSync(join(root, upstreamPath));
  const expected = lock?.plugins?.[plugin]?.files?.[file];
  if (sha256(bytes) !== expected) throw new PayloadError(`${upstreamPath} does not match its sha256 in upstream/lock.json.`, `download ${lock?.plugins?.[plugin]?.source ?? 'the upstream release asset'} again`);
  return Buffer.from(obsidianInstallForm(applyPatches(bytes.toString('utf8'), patches)), 'utf8');
}

export const isPointer = (value) => typeof value === 'string' && (value === '' || value.startsWith('/'));
export const isSemver = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
export const isDigestHex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const isCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/** Compare two semver versions without pre-release tags. */
export function compareVersions(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

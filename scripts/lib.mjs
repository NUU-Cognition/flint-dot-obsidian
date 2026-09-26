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

/** Keys that an appearance profile can set (`OBSIDIAN_PROFILE_KEYS`, Report 083 §8). */
export const PROFILE_KEYS = ['cssTheme', 'translucency', 'enabledCssSnippets', 'showRibbon', 'accentColor', 'baseFontSize'];

/**
 * The allowed keys of applied settings and the value type of each key. This is a copy of
 * `OBSIDIAN_APPLIED_KEYS` in `packages/flint-contracts/src/obsidian.ts` of the flint
 * repository (spec: Applied Settings). Keep the two tables equal: a release that passes
 * this check must pass the CLI, the core, and the plugin.
 * - `string`: any string; with `pattern`, the string must match it.
 * - `integer`: an integer from `min` to `max`.
 * - `enum`: one of `values`.
 * - `list`: a list of strings. Only a list key takes `add` and `remove`.
 */
export const APPLIED_KEYS = {
  appearance: {
    cssTheme: { type: 'string' },
    theme: { type: 'enum', values: ['obsidian', 'moonstone', 'system'] },
    translucency: { type: 'boolean' },
    enabledCssSnippets: { type: 'list' },
    showRibbon: { type: 'boolean' },
    accentColor: { type: 'string', pattern: '^(|#[0-9a-fA-F]{6})$' },
    baseFontSize: { type: 'integer', min: 10, max: 30 },
    interfaceFontFamily: { type: 'string' },
    textFontFamily: { type: 'string' },
    monospaceFontFamily: { type: 'string' },
  },
  app: {
    alwaysUpdateLinks: { type: 'boolean' },
    attachmentFolderPath: { type: 'string' },
    autoPairBrackets: { type: 'boolean' },
    autoPairMarkdown: { type: 'boolean' },
    defaultViewMode: { type: 'enum', values: ['source', 'preview'] },
    foldHeading: { type: 'boolean' },
    foldIndent: { type: 'boolean' },
    livePreview: { type: 'boolean' },
    newFileFolderPath: { type: 'string' },
    newFileLocation: { type: 'enum', values: ['root', 'current', 'folder'] },
    newLinkFormat: { type: 'enum', values: ['shortest', 'relative', 'absolute'] },
    promptDelete: { type: 'boolean' },
    propertiesInDocument: { type: 'enum', values: ['visible', 'hidden', 'source'] },
    readableLineLength: { type: 'boolean' },
    showIndentGuide: { type: 'boolean' },
    showInlineTitle: { type: 'boolean' },
    showLineNumber: { type: 'boolean' },
    smartIndentList: { type: 'boolean' },
    spellcheck: { type: 'boolean' },
    strictLineBreaks: { type: 'boolean' },
    tabSize: { type: 'integer', min: 1, max: 8 },
    trashOption: { type: 'enum', values: ['system', 'local', 'none'] },
    useMarkdownLinks: { type: 'boolean' },
    useTab: { type: 'boolean' },
    userIgnoreFilters: { type: 'list' },
    vimMode: { type: 'boolean' },
  },
};

/** The value type of a key in words, for a refusal message. */
export function describeKeyType(spec) {
  switch (spec.type) {
    case 'boolean': return 'a boolean';
    case 'integer': return `an integer from ${spec.min} to ${spec.max}`;
    case 'enum': return `one of ${spec.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'list': return 'a list of strings';
    default: return spec.pattern ? `a string that matches ${spec.pattern}` : 'a string';
  }
}

/** True when `value` has the type of the key. */
export function isKeyValue(spec, value) {
  switch (spec.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value) && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max);
    case 'enum': return typeof value === 'string' && spec.values.includes(value);
    case 'list': return Array.isArray(value) && value.every((m) => typeof m === 'string');
    default: return typeof value === 'string' && (!spec.pattern || new RegExp(spec.pattern).test(value));
  }
}

/**
 * The problem of one applied entry (`file`, `key`, `op`), or null. This is the rule of
 * `checkObsidianAppliedEntry` in the contracts: `{ set }` for any key, or `{ add, remove }`
 * for a list key, never both forms.
 */
export function appliedEntryProblem(file, key, op) {
  const keys = APPLIED_KEYS[file];
  if (!keys) return `"${file}" is not an applied file (${Object.keys(APPLIED_KEYS).join(', ')})`;
  const spec = Object.hasOwn(keys, key) ? keys[key] : undefined;
  if (!spec) return `"${file}.${key}" is not an allowed key. Allowed keys: ${Object.keys(keys).join(', ')}`;
  if (!op || typeof op !== 'object' || Array.isArray(op)) return `${file}.${key}: the operation must be { "set": … } or { "add": [ … ], "remove": [ … ] }`;
  const fields = Object.keys(op);
  if (fields.includes('set')) {
    if (fields.length !== 1) return `${file}.${key}: an operation with "set" takes no other field`;
    return isKeyValue(spec, op.set) ? null : `${file}.${key}: the value must be ${describeKeyType(spec)}`;
  }
  if (!fields.length || fields.some((f) => f !== 'add' && f !== 'remove')) return `${file}.${key}: the operation must be { "set": … } or { "add": [ … ], "remove": [ … ] }`;
  if (spec.type !== 'list') return `${file}.${key}: "add" and "remove" need a list key; use { "set": … }`;
  for (const f of fields) if (!isKeyValue(spec, op[f])) return `${file}.${key}: "${f}" must be a list of strings`;
  return null;
}

/** Id patterns of the release formats. */
export const PROFILE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MIGRATION_ID = /^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$/;
export const PATCH_ID = /^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$/;
/** A SemVer 2.0.0 version with no leading `v` (the pattern of the core). */
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
  const folded = new Map();
  for (const entry of listTree(root)) {
    const fold = entry.path.toLowerCase();
    if (folded.has(fold)) { problem(entry.path, 'path', `differs only in letter case from ${folded.get(fold)}; macOS compares paths with no case`); continue; }
    folded.set(fold, entry.path);
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
 * Replay patch entries onto an unpatched upstream text. Each `find` anchors on the original
 * upstream text and must occur there exactly once. Edits must not overlap. So the result
 * does not depend on the order of the entries.
 */
export function replayPatches(upstream, patches) {
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
  return Buffer.from(obsidianInstallForm(replayPatches(bytes.toString('utf8'), patches)), 'utf8');
}

export const isPointer = (value) => typeof value === 'string' && (value === '' || value.startsWith('/'));
export const isVersion = (value) => typeof value === 'string' && VERSION_PATTERN.test(value);
export const isDigestHex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const isCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/** The numbers of a version, without the prerelease and build parts. */
const numbers = (version) => version.split('+')[0].split('-')[0].split('.').map(Number);

/** Compare two versions by major, minor, and patch. The prerelease part is not compared. */
export function compareVersions(a, b) {
  const pa = numbers(a);
  const pb = numbers(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const COMPARATOR = /^(>=|<=|>|<|=)?v?(.+)$/;

/**
 * The problem of a `release.json#cli` range, or null. The CLI understands comparator sets
 * with `>=`, `<=`, `>`, `<`, and `=`, joined by `||` (decision C12). It does not understand
 * `^`, `~`, `x`, or hyphen ranges.
 */
export function cliRangeProblem(range) {
  if (typeof range !== 'string' || !range.trim()) return 'the range is empty';
  for (const set of range.split('||')) {
    const comparators = set.trim().split(/\s+/).filter(Boolean);
    if (!comparators.length) return 'a comparator set between "||" is empty';
    for (const comparator of comparators) {
      const match = COMPARATOR.exec(comparator);
      if (!match || !isVersion(match[2])) return `"${comparator}" is not a comparator (>=, <=, >, <, or = and a version)`;
    }
  }
  return null;
}

/** True when a version satisfies a `cli` range. The prerelease part is not compared (decision S29). */
export function satisfiesCliRange(version, range) {
  if (!isVersion(version) || cliRangeProblem(range)) return false;
  return range.split('||').some((set) => set.trim().split(/\s+/).filter(Boolean).every((comparator) => {
    const [, op = '=', bound] = COMPARATOR.exec(comparator);
    const order = compareVersions(version, bound);
    return { '>=': order >= 0, '<=': order <= 0, '>': order > 0, '<': order < 0, '=': order === 0 }[op];
  }));
}

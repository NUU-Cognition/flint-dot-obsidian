import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChecks } from '../check.mjs';
import { cleanup, makeTree } from './fixture.mjs';

/** Run the checks on a changed fixture. Returns the failures of each check as text. */
async function failures(change = () => {}, options = {}, after = () => {}, { manifest = true } = {}) {
  const root = makeTree(change, { manifest });
  try {
    after(root);
    const results = await runChecks(root, options);
    return Object.fromEntries(results.map((r) => [r.name, r.fail.map((f) => f.text).join('\n')]));
  } finally {
    cleanup(root);
  }
}

test('a valid tree passes every check', async () => {
  const f = await failures();
  for (const [name, text] of Object.entries(f)) assert.equal(text, '', name);
});

test('inventory refuses an unclassified path, a retired path, a link, and extra NUU Flint files', async () => {
  const f = await failures((m) => {
    m['plugins/stray/main.js'] = 'x';
    m['payload/plugins/nuu-flint/presets/blank/preset.toml'] = 'x';
    m['flint-obsidian.json'] = {};
  }, {}, (root) => symlinkSync('/etc/hostname', join(root, 'payload/snippets/link.css')), { manifest: false });
  assert.match(f.inventory, /plugins\/stray\/main\.js: no class owns this path/);
  assert.match(f.inventory, /flint-obsidian\.json: 0\.7\.0 retired this path/);
  assert.match(f.inventory, /symbolic link/);
  assert.match(f.inventory, /nuu-flint\/presets: the NUU Flint plugin ships only main\.js/);
  assert.match(f.manifest, /inventory problem/);
});

test('hygiene refuses junk, secrets, installation ids, personal keys, machine paths, and note paths', async () => {
  const f = await failures((m) => {
    m['settings/common/plugins/vertical-tabs/data.json'] = { installationID: 'abc' };
    m['settings/common/plugins/share/data.json'] = { apiKey: 'k-123' };
    m['settings/common/plugins/nuu-flint/data.json'] = { defaultOrbhProfile: 'claude/x' };
    m['settings/common/workspaces.json'] = { workspaces: { Split: { file: 'Mesh/Homepage.md' } }, active: 'Split' };
    m['settings/common/app.json'] = { attachmentFolderPath: '/home/someone/vault' };
    m['docs/token.txt'] = 'ghp_' + 'a'.repeat(36);
  }, {}, (root) => {
    mkdirSync(join(root, 'settings/common'), { recursive: true });
    writeFileSync(join(root, 'settings/common/.DS_Store'), 'x');
  });
  assert.match(f.hygiene, /\.DS_Store: an operating system file/);
  assert.match(f.hygiene, /installationID: a personal or retired key/);
  assert.match(f.hygiene, /apiKey: a secret or an account id/);
  assert.match(f.hygiene, /defaultOrbhProfile: a personal or retired key/);
  assert.match(f.hygiene, /a note path \("Mesh\/Homepage\.md"\)/);
  assert.match(f.hygiene, /machine path/);
  assert.match(f.hygiene, /a GitHub token/);
});

test('replay refuses a bundle that differs from upstream plus the patch log', async () => {
  const f = await failures((m) => { m['payload/plugins/terminal/main.js'] = 'const a="PATCHED-ONE";const b="UPSTREAM-TWO";\n\n/* nosourcemap */'; });
  assert.match(f.replay, /does not equal upstream\/terminal\/main\.js plus 2 patch entries/);
});

test('replay refuses a changed upstream file, a missing lock entry, and a version mismatch', async () => {
  const f = await failures((m) => {
    m['upstream/terminal/main.js'] = 'changed';
    m['payload/plugins/extra/main.js'] = 'x';
    m['payload/plugins/extra/manifest.json'] = { id: 'extra', version: '1.0.0' };
    m['payload/plugins/terminal/manifest.json'] = { id: 'terminal', version: '3.24.0' };
  });
  assert.match(f.replay, /does not match its sha256/);
  assert.match(f.replay, /extra: no entry in upstream\/lock\.json/);
  assert.match(f.replay, /is 3\.23\.0, but the payload bundle is 3\.24\.0/);
});

test('settings refuses dead hotkeys, missing plugins, snippets, and themes', async () => {
  const f = await failures((m) => {
    m['settings/common/hotkeys.json'] = {
      'nuu-obsidian:launch-orbh-interactive-default': [],
      'tab-selector:open-tab-selector': [],
      'insert-current-date': [],
      'terminal:no-such-command': [],
    };
    m['settings/common/community-plugins.json'] = ['terminal', 'nuu-flint', 'obsidian-git'];
    m['settings/common/appearance.json'] = { enabledCssSnippets: ['missing'], cssTheme: 'Nope' };
  });
  assert.match(f.settings, /dead hotkey "nuu-obsidian:launch-orbh-interactive-default" \(no plugin "nuu-obsidian"/);
  assert.match(f.settings, /dead hotkey "tab-selector:open-tab-selector"/);
  assert.match(f.settings, /dead hotkey "insert-current-date" \(the core plugin "templates" is off\)/);
  assert.match(f.settings, /has no command "no-such-command"/);
  assert.match(f.settings, /"obsidian-git" is enabled, but payload\/plugins\/obsidian-git\/ does not exist/);
  assert.match(f.settings, /the snippet "missing" does not exist/);
  assert.match(f.settings, /the theme "Nope" does not exist/);
});

test('settings validates profiles, applied settings, and migrations', async () => {
  const f = await failures((m) => {
    m['profiles/baseline-transparent/profile.json'].platforms = ['win32'];
    m['profiles/baseline-transparent/profile.json'].set.appearance.cssTheme = { set: 'Nope' };
    m['applied.json'] = { schema: 1, appearance: { showRibbon: { add: ['x'] }, fontSizeX: { set: 1 } }, hotkeys: {} };
    m['migrations/0001-rename-hotkey.json'].operations = [{ op: 'replace-file' }, { op: 'remove-key', key: 'no-pointer' }];
  });
  assert.match(f.settings, /"platforms" must list one or more of darwin, linux/);
  assert.match(f.settings, /the theme "Nope" does not exist/);
  assert.match(f.settings, /"hotkeys" is not an applied file/);
  assert.match(f.settings, /appearance\.showRibbon: "add" and "remove" need a list key/);
  assert.match(f.settings, /"appearance\.fontSizeX" is not an allowed key/);
  assert.match(f.settings, /unknown op "replace-file"/);
  assert.match(f.settings, /"key" must be a JSON Pointer/);
});

test('linux-default refuses a Linux default that names a macOS profile', async () => {
  const f = await failures((m) => { m['settings/linux/plugins/terminal/data.json'].defaultProfile = 'darwinIntegratedDefault'; });
  assert.match(f['linux-default'], /is not an integrated linux profile/);
});

test('manifest refuses a stale manifest.json', async () => {
  const f = await failures(() => {}, {}, (root) => writeFileSync(join(root, 'payload/snippets/tabs.css'), '.changed{}\n'));
  assert.match(f.manifest, /does not match the source tree/);
});

test('release refuses a plugin version mismatch; --release refuses a pending source commit', async () => {
  const mismatch = await failures((m) => { m['release.json'].plugin.version = '0.6.9'; });
  assert.match(mismatch.release, /plugin\.version is "0\.6\.9", but the bundle is 0\.7\.0/);

  const pending = (m) => { m['release.json'].plugin.sourceCommit = 'pending'; };
  assert.equal((await failures(pending)).release, '');
  assert.match((await failures(pending, { release: true })).release, /sourceCommit is "pending"/);
});

/** The warnings and failures of the release check, in normal mode and in release mode. */
async function releaseCheck(change) {
  const root = makeTree(change);
  try {
    const normal = (await runChecks(root)).find((r) => r.name === 'release');
    const strict = (await runChecks(root, { release: true })).find((r) => r.name === 'release');
    return { fail: normal.fail.map((x) => x.text).join('\n'), warn: normal.warn.map((x) => x.text).join('\n'), strict: strict.fail.map((x) => x.text).join('\n') };
  } finally {
    cleanup(root);
  }
}

test('G9-1: --release refuses the 0.6.x plugin (version 0.0.1, no describe-manager, trust-vault) and a pending source commit', async () => {
  const legacy = await releaseCheck((m) => {
    m['release.json'].plugin = { id: 'nuu-flint', version: '0.0.1', sourceCommit: 'pending' };
    m['payload/plugins/nuu-flint/manifest.json'] = { id: 'nuu-flint', version: '0.0.1' };
    m['payload/plugins/nuu-flint/versions.json'] = { '0.0.1': '1.5.0' };
    m['payload/plugins/nuu-flint/main.js'] = 'const ops=["trust-vault","open-vault"];\n';
  });
  assert.equal(legacy.fail, '', 'normal mode only warns before the release cut');
  for (const text of [legacy.warn, legacy.strict]) {
    assert.match(text, /plugin 0\.0\.1 is outside the CLI range >=0\.7\.0 <0\.8\.0/);
    assert.match(text, /has no describe-manager operation/);
    assert.match(text, /retired trust-vault operation/);
    assert.match(text, /sourceCommit is "pending"/);
  }
  const current = await releaseCheck();
  assert.equal(current.strict, '');
  assert.equal(current.warn, '');
});

test('G9-2: release refuses a cli range that the CLI does not understand (C12)', async () => {
  for (const cli of ['^0.7.0', '~0.7.0', '>=0.7 <0.8']) {
    const r = await releaseCheck((m) => { m['release.json'].cli = cli; });
    assert.match(r.fail, /is not a comparator range/, cli);
  }
});

test('G9-2: profiles follow the core (remove, value types, ids, empty set, keys of applied.json)', async () => {
  const f = await failures((m) => {
    m['profiles/baseline-transparent/profile.json'].set.appearance = {
      enabledCssSnippets: { remove: ['tabs'] },
      translucency: { set: 'yes' },
      showRibbon: { set: true },
    };
    m['profiles/Bad_Id/profile.json'] = { schema: 1, id: 'Bad_Id', title: 'Bad', description: 'Bad.', platforms: ['linux'], set: { appearance: {} } };
    m['profiles/newer/profile.json'] = { schema: 2, id: 'newer', title: 'Newer', description: 'Newer.', platforms: ['linux'], set: { appearance: { cssTheme: { set: 'Baseline' } } } };
  });
  assert.match(f.settings, /enabledCssSnippets: a profile adds list members and never removes them/);
  assert.match(f.settings, /appearance\.translucency: the value must be a boolean/);
  assert.match(f.settings, /appearance\.showRibbon: applied\.json holds this key/);
  assert.match(f.settings, /the id "Bad_Id" does not match/);
  assert.match(f.settings, /"set\.appearance" must name at least one key/);
  assert.match(f.settings, /"schema" is 2: a newer payload format wrote the file/);
});

test('G9-2: applied.json follows the key and type table, and needs appearance and app', async () => {
  const good = await failures((m) => { m['applied.json'].app = { userIgnoreFilters: { add: ['Exports/'] }, tabSize: { set: 4 } }; });
  assert.equal(good.settings, '');
  const f = await failures((m) => {
    m['applied.json'] = { schema: 1, appearance: { showRibbon: { set: 'no' }, baseFontSize: { set: 99 } }, extra: {} };
  });
  assert.match(f.settings, /"app" must be an object of keys/);
  assert.match(f.settings, /appearance\.showRibbon: the value must be a boolean/);
  assert.match(f.settings, /appearance\.baseFontSize: the value must be an integer from 10 to 30/);
  assert.match(f.settings, /"extra" is not an applied file/);
  const unknown = await failures((m) => { m['applied.json'].app = { noSuchKey: { set: true } }; });
  assert.match(unknown.settings, /"app\.noSuchKey" is not an allowed key/);
});

test('G9-2: migrations and patch entries follow the id patterns and the operation forms of the core', async () => {
  const f = await failures((m) => {
    m['migrations/0001-rename-hotkey.json'] = null;
    m['migrations/0001--Bad.json'] = { schema: 1, id: '0001--Bad', description: 'Bad.', file: 'hotkeys.json', platforms: ['linux'], operations: [{ op: 'remove-key', key: '/x' }] };
    m['migrations/0002-no-text.json'] = { schema: 1, id: '0002-no-text', file: '../app.json', platforms: ['linux'], operations: [{ op: 'list-add', key: '', members: [1] }, { op: 'set-if-equals', key: '/x', from: 'a' }] };
    m['patches/1-short/patch.json'] = { schema: 1, id: '1-short', title: 'x', why: 'x', plugin: 'terminal', file: 'main.js', replacements: [{ find: 'UPSTREAM', replace: 'X' }] };
  }, {}, () => {}, { manifest: false });
  assert.match(f.settings, /the id "0001--Bad" does not match/);
  assert.match(f.settings, /"description" must be a non-empty string/);
  assert.match(f.settings, /"file" must be a settings file path/);
  assert.match(f.settings, /"members" must be a non-empty list of strings/);
  assert.match(f.settings, /"set-if-equals" needs "to"/);
  assert.match(f.replay, /the id "1-short" does not match/);
});

test('G9-2: inventory refuses two destinations that differ only in letter case', async () => {
  const dest = await failures((m) => { m['settings/common/plugins/Terminal/data.json'] = {}; });
  assert.match(dest.inventory, /\.obsidian\/plugins\/terminal\/data\.json and \.obsidian\/plugins\/Terminal\/data\.json differ only in letter case \(linux\)/);
  const source = await failures((m) => { m['payload/snippets/Tabs.css'] = '.x{}\n'; }, {}, () => {}, { manifest: false });
  assert.match(source.inventory, /payload\/snippets\/tabs\.css: differs only in letter case from payload\/snippets\/Tabs\.css/);
});

test('G9-2: format files need a trailing newline and a 2-space indent', async () => {
  const f = await failures((m) => { m['applied.json'] = '{\n\t"schema": 1,\n\t"appearance": {},\n\t"app": {}\n}'; });
  assert.match(f.settings, /applied\.json: the file must end with a newline/);
  assert.match(f.settings, /applied\.json: indent with 2 spaces, not tabs/);
});

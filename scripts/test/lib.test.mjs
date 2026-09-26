import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from '../build.mjs';
import { applyPatches, buildManifest, classify, obsidianInstallForm, sha256 } from '../lib.mjs';
import { cleanup, makeTree } from './fixture.mjs';

test('classify gives each path one class', () => {
  const cases = {
    'payload/plugins/terminal/main.js': 'release',
    'payload/snippets/tabs.css': 'release',
    'payload/themes/Baseline/theme.css': 'release',
    'settings/common/app.json': 'settings',
    'settings/linux/plugins/terminal/data.json': 'settings',
    'profiles/x/profile.json': 'profile',
    'migrations/0001-x.json': 'migration',
    'patches/003-x/patch.json': 'patch',
    'upstream/lock.json': 'upstream',
    'upstream/terminal/main.js': 'upstream',
    'applied.json': 'applied',
    'scripts/build.mjs': 'source',
    'README.md': 'source',
  };
  for (const [path, cls] of Object.entries(cases)) assert.equal(classify(path).class, cls, path);
  for (const path of ['payload/plugins/terminal/data.json', 'payload/app.json', 'payload/workspace.json', 'payload/themes/Omarchy/theme.css', 'settings/common/workspace.json', 'settings/windows/app.json', 'settings/common/snippets/a.css', 'flint-obsidian.json', 'plugins/x/main.js']) {
    assert.equal(classify(path).class, null, path);
  }
});

test('build writes stable bytes with sorted entries', () => {
  const root = makeTree();
  try {
    const first = readFileSync(join(root, 'manifest.json'), 'utf8');
    const { digest } = build(root);
    const second = readFileSync(join(root, 'manifest.json'), 'utf8');
    assert.equal(first, second);
    assert.equal(digest, `sha256:${sha256(Buffer.from(second, 'utf8'))}`);
    const m = JSON.parse(second);
    assert.equal(m.schema, 1);
    assert.equal(m.release, '0.7.0');
    const paths = m.files.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(m.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.mode === '644' && Number.isInteger(f.size)));
    assert.deepEqual(m.settings.linux.map((s) => s.path), ['plugins/terminal/data.json']);
    assert.ok(!m.settings.common.some((s) => s.path === 'plugins/terminal/data.json'));
    assert.deepEqual(m.profiles.map((p) => p.id), ['baseline-transparent']);
    assert.deepEqual(m.migrations.map((p) => p.path), ['migrations/0001-rename-hotkey.json']);
    assert.equal(m.applied.path, 'applied.json');
    assert.deepEqual(Object.keys(m), ['schema', 'release', 'files', 'settings', 'profiles', 'migrations', 'applied']);
  } finally {
    cleanup(root);
  }
});

test('build refuses junk and a data.json file among the release files', () => {
  for (const [path, pattern] of [['payload/.DS_Store', /operating system file/], ['payload/plugins/terminal/data.json', /settings file/], ['payload/plugins/terminal/main.js.bak', /backup/]]) {
    const root = makeTree((f) => { f[path] = 'x'; }, { manifest: false });
    try {
      assert.throws(() => buildManifest(root), pattern);
    } finally {
      cleanup(root);
    }
  }
});

test('build records the executable mode', () => {
  const root = makeTree();
  try {
    writeFileSync(join(root, 'payload/plugins/terminal/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    const m = buildManifest(root);
    assert.equal(m.files.find((f) => f.path === 'plugins/terminal/run.sh').mode, '755');
  } finally {
    cleanup(root);
  }
});

test('applyPatches anchors on the original text and ignores the order of the entries', () => {
  const upstream = 'A1 B2 C3';
  const p1 = { id: '001', plugin: 'x', file: 'main.js', replacements: [{ find: 'A1', replace: 'B2-new' }] };
  const p2 = { id: '002', plugin: 'x', file: 'main.js', replacements: [{ find: 'B2', replace: 'b' }] };
  assert.equal(applyPatches(upstream, [p1, p2]), 'B2-new b C3');
  assert.equal(applyPatches(upstream, [p2, p1]), 'B2-new b C3');
});

test('applyPatches refuses a missing, a repeated, or an overlapping anchor', () => {
  const entry = (find) => ({ id: '001', plugin: 'x', file: 'main.js', replacements: [{ find, replace: 'z' }] });
  assert.throws(() => applyPatches('abc', [entry('zzz')]), /not in the upstream file/);
  assert.throws(() => applyPatches('abab', [entry('ab')]), /more than once/);
  assert.throws(() => applyPatches('abcdef', [entry('abcd'), { ...entry('cdef'), id: '002' }]), /overlaps/);
});

test('obsidianInstallForm removes inline source maps and adds the trailer', () => {
  assert.equal(obsidianInstallForm('code;\n'), 'code;\n\n/* nosourcemap */');
  assert.equal(obsidianInstallForm('code;\n//# sourceMappingURL=data:application/json;base64,AAAA\n'), 'code;\n\n\n/* nosourcemap */');
});

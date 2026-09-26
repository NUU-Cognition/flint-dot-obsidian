import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importPlugin } from '../import-plugin.mjs';
import { release } from '../release.mjs';
import { cleanup, makeTree } from './fixture.mjs';

const COMMIT = 'b'.repeat(40);

function pluginBuild({ id = 'nuu-flint', version = '0.7.1', skip = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-build-'));
  const files = {
    'main.js': 'const ops=["describe-manager"];addCommand({id:"launch-orbh-interactive-default"});// new build\n',
    'manifest.json': JSON.stringify({ id, version }),
    'styles.css': '.new{}\n',
    'versions.json': JSON.stringify({ [version]: '1.5.0' }),
  };
  for (const [name, body] of Object.entries(files)) if (!skip.includes(name)) writeFileSync(join(dir, name), body);
  mkdirSync(join(dir, 'presets/blank'), { recursive: true });
  writeFileSync(join(dir, 'presets/blank/preset.toml'), 'x');
  return dir;
}

test('import-plugin copies the four files, records the commit, and refreshes the manifest', async () => {
  const root = makeTree((m) => { m['payload/plugins/nuu-flint/old-prompt.md'] = 'x'; }, { manifest: false });
  const dir = pluginBuild();
  try {
    const { version, digest } = importPlugin(dir, COMMIT, root, { protocol: 3 });
    assert.equal(version, '0.7.1');
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    const rel = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
    assert.deepEqual(rel.plugin, { id: 'nuu-flint', version: '0.7.1', sourceCommit: COMMIT });
    assert.equal(rel.protocol, 3);
    assert.match(readFileSync(join(root, 'payload/plugins/nuu-flint/main.js'), 'utf8'), /new build/);
    assert.throws(() => readFileSync(join(root, 'payload/plugins/nuu-flint/old-prompt.md')));
    assert.throws(() => readFileSync(join(root, 'payload/plugins/nuu-flint/presets/blank/preset.toml')));
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    assert.ok(manifest.files.some((f) => f.path === 'plugins/nuu-flint/styles.css'));
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('import-plugin refuses a short commit, a missing file, and another plugin', () => {
  const root = makeTree();
  const ok = pluginBuild();
  const missing = pluginBuild({ skip: ['versions.json'] });
  const other = pluginBuild({ id: 'nuu-flint-helper' });
  try {
    assert.throws(() => importPlugin(ok, 'abc123', root), /not a full commit id/);
    assert.throws(() => importPlugin(missing, COMMIT, root), /has no versions\.json/);
    assert.throws(() => importPlugin(other, COMMIT, root), /not "nuu-flint"/);
    assert.throws(() => importPlugin(ok, COMMIT, root), /Could not read OBSIDIAN_CONTROL_PROTOCOL/);
  } finally {
    for (const dir of [root, ok, missing, other]) cleanup(dir);
  }
});

test('import-plugin reads the control protocol of the commit from the flint repository of the build', () => {
  const repo = mkdtempSync(join(tmpdir(), 'flint-repo-'));
  const root = makeTree();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  try {
    mkdirSync(join(repo, 'packages/flint-contracts/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/flint-contracts/src/obsidian.ts'), 'export const OBSIDIAN_CONTROL_PROTOCOL = 2;\n');
    const build = pluginBuild();
    execFileSync('cp', ['-r', build, join(repo, 'apps-plugin')]);
    cleanup(build);
    git('init', '--quiet');
    git('add', '.');
    git('commit', '--quiet', '-m', 'init');
    const commit = git('rev-parse', 'HEAD');
    // The working tree changes after the commit; the script reads the committed value.
    writeFileSync(join(repo, 'packages/flint-contracts/src/obsidian.ts'), 'export const OBSIDIAN_CONTROL_PROTOCOL = 9;\n');
    const r = importPlugin(join(repo, 'apps-plugin'), commit, root);
    assert.equal(r.protocol, 2);
    const rel = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
    assert.equal(rel.protocol, 2);
    assert.equal(rel.plugin.sourceCommit, commit);
  } finally {
    cleanup(repo);
    cleanup(root);
  }
});

function gitTree(change) {
  const root = makeTree(change);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  git('commit', '--quiet', '-m', 'init');
  // release.mjs runs git with the environment of this process.
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) process.env[key] = env[key];
  return { root, git };
}

test('release bumps the version, builds, commits, and does not tag', async () => {
  const { root, git } = gitTree();
  try {
    const r = await release('0.7.1', root);
    assert.equal(r.committed, true);
    assert.equal(r.cli, '>=0.7.0 <0.8.0');
    assert.equal(JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')).version, '0.7.1');
    assert.equal(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).release, '0.7.1');
    assert.equal(git('log', '-1', '--format=%s'), 'Release Obsidian payload v0.7.1');
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('tag', '--list'), '');
  } finally {
    cleanup(root);
  }
});

test('release refuses a dirty tree, a lower version, an existing tag, and failed checks', async () => {
  const dirty = gitTree();
  const pending = gitTree((m) => { m['release.json'].plugin.sourceCommit = 'pending'; });
  try {
    await assert.rejects(release('0.6.0', dirty.root), /lower than the current version/);
    dirty.git('tag', 'v0.7.0');
    await assert.rejects(release('0.7.0', dirty.root), /tag v0\.7\.0 already exists/);
    writeFileSync(join(dirty.root, 'README.md'), 'changed\n');
    await assert.rejects(release('0.7.1', dirty.root), /working tree has changes/);

    const before = readFileSync(join(pending.root, 'release.json'), 'utf8');
    await assert.rejects(release('0.7.1', pending.root), /release checks failed[\s\S]*sourceCommit is "pending"/);
    assert.equal(readFileSync(join(pending.root, 'release.json'), 'utf8'), before);
    assert.equal(pending.git('status', '--porcelain'), '');
  } finally {
    cleanup(dirty.root);
    cleanup(pending.root);
  }
});

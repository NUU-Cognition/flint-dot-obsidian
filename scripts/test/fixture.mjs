// A small, valid payload source tree for the tests. Each test changes one fact and runs a script.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from '../build.mjs';
import { INSTALL_TRAILER, sha256, toJson } from '../lib.mjs';

export const UPSTREAM = 'const a="UPSTREAM-ONE";const b="UPSTREAM-TWO";\n';
export const COMMIT = 'a'.repeat(40);

const terminalProfiles = {
  darwinIntegratedDefault: { executable: '/bin/zsh', args: [], platforms: { darwin: true }, type: 'integrated' },
  linuxIntegratedDefault: { executable: '/bin/bash', args: ['--login'], platforms: { linux: true }, type: 'integrated' },
};

export function files() {
  return {
    'release.json': { schema: 1, version: '0.7.0', cli: '>=0.7.0 <0.8.0', protocol: 2, plugin: { id: 'nuu-flint', version: '0.7.0', sourceCommit: COMMIT }, obsidian: { tested: ['1.13.7'] } },
    'applied.json': { schema: 1, appearance: { showRibbon: { set: false } }, app: {} },
    'payload/plugins/nuu-flint/main.js': 'addCommand({id:"launch-orbh-interactive-default"});\n',
    'payload/plugins/nuu-flint/manifest.json': { id: 'nuu-flint', version: '0.7.0' },
    'payload/plugins/nuu-flint/styles.css': '.x{}\n',
    'payload/plugins/nuu-flint/versions.json': { '0.7.0': '1.5.0' },
    'payload/plugins/terminal/main.js': 'const a="PATCHED-ONE";const b="PATCHED-TWO";\n' + INSTALL_TRAILER,
    'payload/plugins/terminal/manifest.json': { id: 'terminal', version: '3.23.0' },
    'payload/snippets/tabs.css': '.tabs{}\n',
    'payload/themes/Baseline/manifest.json': { name: 'Baseline' },
    'payload/themes/Baseline/theme.css': 'body{}\n',
    'settings/common/community-plugins.json': ['terminal', 'nuu-flint'],
    'settings/common/core-plugins.json': { 'file-explorer': true, templates: false },
    'settings/common/hotkeys.json': { 'nuu-flint:launch-orbh-interactive-default': [{ modifiers: ['Mod'], key: 'N' }], 'app:toggle-left-sidebar': [], 'file-explorer:new-file': [] },
    'settings/common/appearance.json': { showRibbon: false, enabledCssSnippets: ['tabs'] },
    'settings/common/workspaces.json': { workspaces: { Split: {} }, active: 'Split' },
    'settings/common/plugins/nuu-flint/data.json': {},
    'settings/darwin/plugins/terminal/data.json': { profiles: terminalProfiles, defaultProfile: 'darwinIntegratedDefault' },
    'settings/linux/plugins/terminal/data.json': { profiles: terminalProfiles, defaultProfile: 'linuxIntegratedDefault' },
    'profiles/baseline-transparent/profile.json': { schema: 1, id: 'baseline-transparent', title: 'Baseline Transparent', description: 'Test.', platforms: ['darwin'], set: { appearance: { cssTheme: { set: 'Baseline' }, enabledCssSnippets: { add: ['tabs'] } } } },
    'migrations/0001-rename-hotkey.json': { schema: 1, id: '0001-rename-hotkey', description: 'Test.', file: 'hotkeys.json', platforms: ['darwin', 'linux'], operations: [{ op: 'rename-key', from: '/old:cmd', to: '/nuu-flint:cmd' }] },
    'patches/001-one/patch.json': { schema: 1, id: '001-one', title: 'One', why: 'Test.', plugin: 'terminal', file: 'main.js', replacements: [{ find: '"UPSTREAM-ONE"', replace: '"PATCHED-ONE"' }] },
    'patches/002-two/patch.json': { schema: 1, id: '002-two', title: 'Two', why: 'Test.', plugin: 'terminal', file: 'main.js', replacements: [{ find: '"UPSTREAM-TWO"', replace: '"PATCHED-TWO"' }] },
    'upstream/terminal/main.js': UPSTREAM,
    'upstream/lock.json': { schema: 1, plugins: { terminal: { version: '3.23.0', source: 'https://example.invalid/terminal/3.23.0/main.js', files: { 'main.js': sha256(UPSTREAM) } } } },
    'README.md': '# Test\n',
  };
}

/** Write a fixture tree. `change` edits the file map first; a value of `null` deletes the file. */
export function makeTree(change = () => {}, { manifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'payload-source-'));
  const map = files();
  change(map);
  for (const [path, value] of Object.entries(map)) {
    if (value === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : toJson(value));
  }
  if (manifest) build(root);
  return root;
}

export const cleanup = (root) => rmSync(root, { recursive: true, force: true });

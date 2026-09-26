#!/usr/bin/env node
// Copy a build of the NUU Flint plugin into payload/plugins/nuu-flint/ and record its source commit.
//
// Usage: node scripts/import-plugin.mjs <build dir> <flint commit>
//   <build dir>     The folder of the plugin build, for example <flint repo>/apps/nuu-flint-plugin
//   <flint commit>  The full commit id of the flint repository that the build comes from

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from './build.mjs';
import { isCommit, isMain, isSemver, NUU_PLUGIN, NUU_PLUGIN_FILES, PayloadError, readJson, ROOT, toJson } from './lib.mjs';

export function importPlugin(buildDir, commit, root = ROOT) {
  const from = resolve(buildDir);
  if (!existsSync(from)) throw new PayloadError(`The build folder ${from} does not exist.`, 'give the folder of the plugin build, for example <flint repo>/apps/nuu-flint-plugin');
  if (!isCommit(commit)) throw new PayloadError(`"${commit}" is not a full commit id.`, 'git -C <flint repo> rev-parse HEAD');
  for (const file of NUU_PLUGIN_FILES) {
    if (!existsSync(join(from, file))) throw new PayloadError(`The build has no ${file}.`, 'build the plugin first: pnpm --filter @nuucognition/nuu-flint-plugin build');
  }
  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
  if (manifest.id !== NUU_PLUGIN) throw new PayloadError(`The build is the plugin "${manifest.id}", not "${NUU_PLUGIN}".`, 'give the folder of the NUU Flint plugin build');
  if (!isSemver(manifest.version)) throw new PayloadError(`The build version "${manifest.version}" is not a semantic version.`, 'fix manifest.json of the plugin source');
  const versions = JSON.parse(readFileSync(join(from, 'versions.json'), 'utf8'));
  if (!(manifest.version in versions)) throw new PayloadError(`versions.json of the build has no entry for ${manifest.version}.`, 'run the version script of the plugin source, then build again');

  const to = join(root, 'payload/plugins', NUU_PLUGIN);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(to)) if (!NUU_PLUGIN_FILES.includes(name)) rmSync(join(to, name), { recursive: true, force: true });
  for (const file of NUU_PLUGIN_FILES) copyFileSync(join(from, file), join(to, file));

  const release = readJson(root, 'release.json');
  release.plugin = { ...release.plugin, id: NUU_PLUGIN, version: manifest.version, sourceCommit: commit };
  writeFileSync(join(root, 'release.json'), toJson(release));
  const { digest } = build(root);
  return { version: manifest.version, commit, digest };
}

if (isMain(import.meta.url)) {
  const [buildDir, commit, ...rest] = process.argv.slice(2);
  try {
    if (!buildDir || !commit || rest.length) throw new PayloadError('Give a build folder and a flint commit.', 'node scripts/import-plugin.mjs <build dir> <flint commit>');
    const { version, digest } = importPlugin(buildDir, commit);
    console.log(`NUU Flint plugin ${version} imported from ${commit.slice(0, 12)}.`);
    console.log(`  release.json : plugin ${version}, sourceCommit ${commit}`);
    console.log(`  manifest.json: ${digest}`);
    console.log('Next: node scripts/check.mjs, then commit payload/plugins/nuu-flint, release.json, and manifest.json');
  } catch (error) {
    console.error(`✖ ${error.message}`);
    if (error.next) console.error(`  Next: ${error.next}`);
    process.exit(1);
  }
}

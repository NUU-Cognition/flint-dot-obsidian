#!/usr/bin/env node
// Copy a build of the NUU Flint plugin into payload/plugins/nuu-flint/, and record its version,
// its source commit, and its control protocol in release.json.
//
// Usage: node scripts/import-plugin.mjs <build dir> <flint commit> [--protocol <n>]
//   <build dir>     The folder of the plugin build, for example <flint repo>/apps/nuu-flint-plugin
//   <flint commit>  The full commit id of the flint repository that the build comes from
//   --protocol <n>  The control protocol of the build. Without it, the script reads
//                   OBSIDIAN_CONTROL_PROTOCOL of <flint commit> in the flint repository of <build dir>.
// In the flint repository, `node apps/nuu-flint-plugin/scripts/deploy.mjs --payload <this folder>` runs this script.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from './build.mjs';
import { isCommit, isMain, isVersion, NUU_PLUGIN, NUU_PLUGIN_FILES, PayloadError, readJson, ROOT, toJson } from './lib.mjs';

const CONTRACTS = 'packages/flint-contracts/src/obsidian.ts';
const USAGE = 'node scripts/import-plugin.mjs <build dir> <flint commit> [--protocol <n>]';

/** OBSIDIAN_CONTROL_PROTOCOL of the commit, read from the flint repository that holds the build folder, or null. */
export function protocolAt(buildDir, commit) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const top = git('-C', buildDir, 'rev-parse', '--show-toplevel').trim();
    const match = /OBSIDIAN_CONTROL_PROTOCOL\s*=\s*(\d+)/.exec(git('-C', top, 'show', `${commit}:${CONTRACTS}`));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function importPlugin(buildDir, commit, root = ROOT, { protocol } = {}) {
  const from = resolve(buildDir);
  if (!existsSync(from)) throw new PayloadError(`The build folder ${from} does not exist.`, 'give the folder of the plugin build, for example <flint repo>/apps/nuu-flint-plugin');
  if (!isCommit(commit)) throw new PayloadError(`"${commit}" is not a full commit id.`, 'git -C <flint repo> rev-parse HEAD');
  for (const file of NUU_PLUGIN_FILES) {
    if (!existsSync(join(from, file))) throw new PayloadError(`The build has no ${file}.`, 'build the plugin first: pnpm --dir apps/nuu-flint-plugin build');
  }
  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
  if (manifest.id !== NUU_PLUGIN) throw new PayloadError(`The build is the plugin "${manifest.id}", not "${NUU_PLUGIN}".`, 'give the folder of the NUU Flint plugin build');
  if (!isVersion(manifest.version)) throw new PayloadError(`The build version "${manifest.version}" is not a version.`, 'fix manifest.json of the plugin source');
  const versions = JSON.parse(readFileSync(join(from, 'versions.json'), 'utf8'));
  if (!(manifest.version in versions)) throw new PayloadError(`versions.json of the build has no entry for ${manifest.version}.`, 'run the version script of the plugin source, then build again');
  const controlProtocol = protocol ?? protocolAt(from, commit);
  if (!Number.isInteger(controlProtocol) || controlProtocol < 1) {
    throw new PayloadError(`Could not read OBSIDIAN_CONTROL_PROTOCOL of ${commit} from ${CONTRACTS}.`, `${USAGE.replace('[--protocol <n>]', '--protocol <n>')}`);
  }

  const to = join(root, 'payload/plugins', NUU_PLUGIN);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(to)) if (!NUU_PLUGIN_FILES.includes(name)) rmSync(join(to, name), { recursive: true, force: true });
  for (const file of NUU_PLUGIN_FILES) copyFileSync(join(from, file), join(to, file));

  const release = readJson(root, 'release.json');
  release.protocol = controlProtocol;
  release.plugin = { ...release.plugin, id: NUU_PLUGIN, version: manifest.version, sourceCommit: commit };
  writeFileSync(join(root, 'release.json'), toJson(release));
  const { digest } = build(root);
  return { version: manifest.version, commit, protocol: controlProtocol, digest };
}

function parseArgs(argv) {
  const positional = [];
  let protocol;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--protocol') {
      protocol = Number(argv[++i]);
      if (!Number.isInteger(protocol) || protocol < 1) throw new PayloadError('--protocol needs a whole number.', USAGE);
    } else if (argv[i].startsWith('-')) {
      throw new PayloadError(`Unknown option: ${argv[i]}`, USAGE);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) throw new PayloadError('Give a build folder and a flint commit.', USAGE);
  return { buildDir: positional[0], commit: positional[1], protocol };
}

if (isMain(import.meta.url)) {
  try {
    const { buildDir, commit, protocol } = parseArgs(process.argv.slice(2));
    const r = importPlugin(buildDir, commit, ROOT, { protocol });
    console.log(`NUU Flint plugin ${r.version} imported from ${commit.slice(0, 12)}.`);
    console.log(`  release.json : plugin ${r.version}, sourceCommit ${commit}, protocol ${r.protocol}`);
    console.log(`  manifest.json: ${r.digest}`);
    console.log('Next: node scripts/check.mjs --release, then commit payload/plugins/nuu-flint, release.json, and manifest.json');
  } catch (error) {
    console.error(`✖ ${error.message}`);
    if (error.next) console.error(`  Next: ${error.next}`);
    process.exit(1);
  }
}

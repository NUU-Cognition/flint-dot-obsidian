#!/usr/bin/env node
// Prepare a payload release: set the version, build the manifest, run the checks in release
// mode, and commit release.json and manifest.json. This script never tags and never pushes.
// It prints the tag and push commands for the maintainer.
//
// Usage: node scripts/release.mjs <version>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from './build.mjs';
import { render, runChecks } from './check.mjs';
import { compareVersions, isMain, isSemver, PayloadError, readJson, ROOT, toJson } from './lib.mjs';

const RELEASE_FILES = ['release.json', 'manifest.json'];

export async function release(version, root = ROOT) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (!isSemver(version)) throw new PayloadError(`"${version}" is not a semantic version.`, 'node scripts/release.mjs <major.minor.patch>');
  const current = readJson(root, 'release.json').version;
  if (compareVersions(version, current) < 0) throw new PayloadError(`${version} is lower than the current version ${current}.`, `node scripts/release.mjs <a version of ${current} or higher>`);
  if (git('tag', '--list', `v${version}`)) throw new PayloadError(`The tag v${version} already exists.`, 'choose the next version');
  if (git('status', '--porcelain')) throw new PayloadError('The working tree has changes. The release commit must hold only release.json and manifest.json.', 'commit or remove your changes, then run the release again');

  const before = Object.fromEntries(RELEASE_FILES.map((f) => [f, readFileSync(join(root, f))]));
  const restore = () => { for (const f of RELEASE_FILES) writeFileSync(join(root, f), before[f]); };
  try {
    const data = readJson(root, 'release.json');
    data.version = version;
    writeFileSync(join(root, 'release.json'), toJson(data));
    const { digest } = build(root);
    const results = await runChecks(root, { release: true });
    const report = render(results, { release: true, version });
    if (report.failed) throw new PayloadError(`The release checks failed. No file changed.\n${report.text}`, 'fix each failure, then run the release again');
    const changed = git('status', '--porcelain', '--', ...RELEASE_FILES);
    if (changed) git('commit', '--quiet', '-m', `Release Obsidian payload v${version}`, '--', ...RELEASE_FILES);
    return { version, digest, commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), committed: Boolean(changed), report: report.text };
  } catch (error) {
    restore();
    throw error;
  }
}

if (isMain(import.meta.url)) {
  const [version, ...rest] = process.argv.slice(2);
  try {
    if (!version || rest.length) throw new PayloadError('Give one version.', 'node scripts/release.mjs <version>');
    const r = await release(version);
    console.log(r.report);
    console.log('');
    console.log(`Obsidian payload ${r.version} is ready on branch ${r.branch}.`);
    console.log(`  Commit  : ${r.commit}${r.committed ? '' : ' (no change: release.json and manifest.json were current)'}`);
    console.log(`  Manifest: ${r.digest}`);
    if (r.branch !== 'main') console.log('  ⚠ Releases come from main (decision D3). Merge this commit into main before you tag.');
    console.log('Next:');
    console.log(`  git tag -a v${r.version} -m "Obsidian payload ${r.version}" ${r.commit}`);
    console.log(`  git push origin main v${r.version}`);
    console.log(`  Then, in the flint repo: pnpm obsidian:recommend v${r.version}`);
  } catch (error) {
    console.error(`✖ ${error.message}`);
    if (error.next) console.error(`  Next: ${error.next}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
// Write manifest.json from the source tree. Never edit manifest.json by hand.
//
// Usage: node scripts/build.mjs

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, isMain, PayloadError, ROOT, sha256, toJson } from './lib.mjs';

export function build(root = ROOT) {
  const text = toJson(buildManifest(root));
  writeFileSync(join(root, 'manifest.json'), text);
  return { digest: `sha256:${sha256(Buffer.from(text, 'utf8'))}`, manifest: JSON.parse(text) };
}

if (isMain(import.meta.url)) {
  try {
    const { digest, manifest } = build();
    const s = manifest.settings;
    console.log(`manifest.json written for release ${manifest.release}.`);
    console.log(`  Release files : ${manifest.files.length}`);
    console.log(`  Settings files: ${s.common.length} common · ${s.darwin.length} darwin · ${s.linux.length} linux`);
    console.log(`  Profiles      : ${manifest.profiles.length} · Migrations: ${manifest.migrations.length}`);
    console.log(`  Digest        : ${digest}`);
    console.log('Next: node scripts/check.mjs');
  } catch (error) {
    console.error(`✖ ${error.message}`);
    if (error instanceof PayloadError && error.next) console.error(`  Next: ${error.next}`);
    process.exit(1);
  }
}

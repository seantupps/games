#!/usr/bin/env node
/**
 * Bundle build/rummikub/ai for the browser iframe.
 *   npm run rummikub:bundle
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AI_DIR = path.join(ROOT, 'build', 'rummikub', 'ai');
const OUT = path.join(ROOT, 'games', 'rummikub', 'rummikub-core.js');
const ESBUILD = path.join(AI_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild');

function main() {
  if (!fs.existsSync(ESBUILD)) {
    console.error('[rummikub:bundle] Run npm run rummikub:install first');
    process.exit(1);
  }
  const r = spawnSync(
    process.execPath,
    [
      ESBUILD,
      'src/browser.ts',
      '--bundle',
      '--format=iife',
      '--global-name=RummikubCore',
      `--outfile=${OUT}`,
      '--platform=browser',
      '--target=es2020'
    ],
    { cwd: AI_DIR, stdio: 'inherit' }
  );
  process.exit(r.status ?? 1);
}

main();

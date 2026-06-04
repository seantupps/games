#!/usr/bin/env node
/**
 * Run rummikub ai npm commands from build/rummikub/ai (avoids npm --prefix bug
 * when root package.json has no "name" field).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AI_DIR = path.join(__dirname, '..', 'build', 'rummikub', 'ai');
const PLAY_JS = path.join(AI_DIR, 'dist', 'play.js');
const TSX_BIN = path.join(AI_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * npm run rummikub:play --placed 53 --seed 42
 * npm treats --placed/--seed as npm config and forwards bare values (53 42).
 */
function playArgsFromEnv(argvRest) {
  const out = [];
  const positional = [];

  for (let i = 0; i < argvRest.length; i++) {
    const a = argvRest[i];
    if (a.startsWith('--')) {
      out.push(a);
      if (i + 1 < argvRest.length && !argvRest[i + 1].startsWith('--')) {
        out.push(argvRest[++i]);
      }
    } else {
      positional.push(a);
    }
  }

  const has = (flag) => out.some((a, i) => a === flag && out[i + 1] != null);
  const cfg = process.env;
  const ints = positional.filter((v) => /^\d+$/.test(v));

  if (cfg.npm_config_demo === 'true' && !out.includes('--demo')) out.push('--demo');
  if (cfg.npm_config_timeout && !has('--timeout')) out.push('--timeout', cfg.npm_config_timeout);
  if (cfg.npm_config_variant && !has('--variant')) out.push('--variant', cfg.npm_config_variant);

  const placedCfg = cfg.npm_config_placed;
  const runsCfg = cfg.npm_config_runs;
  const seedCfg = cfg.npm_config_seed;
  const removeCfg = cfg.npm_config_remove;

  if (!has('--remove') && removeCfg && removeCfg !== 'true') {
    out.push('--remove', removeCfg);
  }

  // npm run … --placed 53 --runs 3 --seed 42 → play 53 3 42 (flags stripped)
  if (
    !has('--placed') &&
    !has('--runs') &&
    !has('--seed') &&
    ints.length === 3 &&
    parseInt(ints[2], 10) >= 3
  ) {
    out.push('--placed', ints[0], '--runs', ints[1], '--seed', ints[2]);
    return out;
  }
  if (!has('--placed') && !has('--seed') && ints.length === 2 && parseInt(ints[0], 10) >= 3) {
    out.push('--placed', ints[0], '--seed', ints[1]);
    return out;
  }

  if (!has('--placed')) {
    if (placedCfg && placedCfg !== 'true') out.push('--placed', placedCfg);
    else {
      const tileCount = ints.find((v) => {
        const n = parseInt(v, 10);
        return n >= 3 && n <= 160;
      });
      if (tileCount) out.push('--placed', tileCount);
    }
  }

  if (!has('--runs')) {
    if (runsCfg && runsCfg !== 'true') out.push('--runs', runsCfg);
    else {
      const placedVal = out.includes('--placed') ? out[out.indexOf('--placed') + 1] : null;
      const runsCandidate = ints.find((v) => {
        if (v === placedVal) return false;
        const n = parseInt(v, 10);
        return n >= 1 && n <= 100;
      });
      if (runsCandidate) out.push('--runs', runsCandidate);
    }
  }

  if (!has('--seed')) {
    if (seedCfg && seedCfg !== 'true') out.push('--seed', seedCfg);
    else {
      const used = new Set(
        ['--placed', '--runs']
          .map((f) => (out.includes(f) ? out[out.indexOf(f) + 1] : null))
          .filter(Boolean)
      );
      const seed = ints.find((v) => !used.has(v));
      if (seed) out.push('--seed', seed);
    }
  }

  return out;
}

function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, {
    cwd: AI_DIR,
    stdio: 'inherit',
    shell: false,
    env: process.env,
    ...opts
  });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  return r.status ?? 0;
}

function runOrExit(exe, args, opts = {}) {
  process.exit(run(exe, args, opts));
}

function runPlay(args) {
  // Prefer compiled JS (~50ms startup) over tsx (~500ms–1.7s on Windows).
  if (fs.existsSync(PLAY_JS)) {
    runOrExit(process.execPath, [PLAY_JS, ...args]);
    return;
  }
  if (fs.existsSync(TSX_BIN)) {
    runOrExit(process.execPath, [TSX_BIN, 'src/play.ts', ...args]);
    return;
  }
  runOrExit('npx', ['tsx', 'src/play.ts', ...args], { shell: true });
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'install') {
  const code = run('npm', ['install'], { shell: true });
  if (code !== 0) process.exit(code);
  process.exit(run('npm', ['run', 'build'], { shell: true }));
} else if (cmd === 'play') {
  runPlay(playArgsFromEnv(rest));
} else if (cmd === 'build') {
  process.exit(run('npm', ['run', 'build'], { shell: true }));
} else {
  console.error(`Usage:
  node tools/rummikub-cli.js install
  node tools/rummikub-cli.js build
  node tools/rummikub-cli.js play [--seed N] [--placed N] [--remove P] [--runs N] [--demo]`);
  process.exit(1);
}

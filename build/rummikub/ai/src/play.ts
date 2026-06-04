#!/usr/bin/env node
/**
 * Rummikub puzzle terminal — generate solved board, optional removal, solve.
 *
 *   npx tsx src/play.ts --seed 42 --remove 30   # steps 1–4 (gen → remove → player start → audit)
 *   npx tsx src/play.ts --placed 106 --runs 3
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { makeRng } from './rng.js';
import { generateSolvedBoard, demoResult } from './puzzle.js';
import { runBoardSolve, runAuditSolve } from './puzzle-game.js';
import { removePercentFromBoard, gridTileCount } from './remove.js';
import { Transcript } from './transcript.js';
import type { Variant } from './types.js';
import { defaultPlacedCount, expectedPoolSize } from './tiles.js';
import { isAchievableTarget } from './board-gen.js';
import type { Puzzle } from './puzzle.js';

const DEFAULT_TIMEOUT_SEC = 3;
const FULL_BOARD_TIMEOUT_SEC = 15;
const MIN_PLACED = 3;

interface CliArgs {
  seed: number | null;
  placed: number | null;
  remove: number | null;
  runs: number;
  timeout: number;
  variant: Variant;
  demo: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    seed: null,
    placed: null,
    remove: null,
    runs: 1,
    timeout: DEFAULT_TIMEOUT_SEC,
    variant: 'standard',
    demo: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--seed' && argv[i + 1]) out.seed = parseInt(argv[++i]!, 10);
    else if (a === '--placed' && argv[i + 1]) out.placed = parseInt(argv[++i]!, 10);
    else if (a === '--remove' && argv[i + 1]) out.remove = parseFloat(argv[++i]!);
    else if (a === '--runs' && argv[i + 1]) out.runs = parseInt(argv[++i]!, 10);
    else if (a === '--timeout' && argv[i + 1]) out.timeout = parseFloat(argv[++i]!);
    else if (a === '--variant' && argv[i + 1]) {
      const v = argv[++i]!.toLowerCase();
      if (v === 'standard' || v === 'xp') out.variant = v;
    } else if (a === '--demo') out.demo = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp(): void {
  const full = defaultPlacedCount('standard');
  console.log(`Usage: npx tsx src/play.ts [options]

Generate a solved board; with --remove runs steps 2–4 (peel → player start → audit win).

Options:
  --seed N        RNG seed (default: random; with --runs N uses seed, seed+1, …)
  --placed N      Tiles on solved board (default: full set, ${full})
  --remove P      Peel P% to rack, build player start, verify full solve
  --runs N        Repeat generation N times (default 1)
  --timeout sec   Generation time limit per run (default 3, longer for full board)
  --variant NAME  standard | xp
  --demo          Fixed small layout sketch
  --help

Docs: ../rules.txt  ../distribution.txt`);
}

function validatePlaced(placed: number, variant: Variant): string | null {
  const poolSize = expectedPoolSize(variant);
  if (!Number.isFinite(placed) || placed < MIN_PLACED || placed > poolSize) {
    return `error: --placed must be between ${MIN_PLACED} and ${poolSize}`;
  }
  if (!isAchievableTarget(placed)) {
    return `error: --placed ${placed} cannot be formed from 3–6 tile melds`;
  }
  return null;
}

function validateRemove(remove: number): string | null {
  if (!Number.isFinite(remove) || remove <= 0 || remove >= 100) {
    return 'error: --remove must be between 0 and 100 (exclusive)';
  }
  return null;
}

function runSeed(baseSeed: number | null, runIndex: number): number {
  if (baseSeed != null) return (baseSeed + runIndex) >>> 0;
  return (Math.floor(Math.random() * 1_000_001) + runIndex) >>> 0;
}

function genTimeoutSec(placed: number, variant: Variant, timeout: number): number {
  if (timeout <= 0) return Number.MAX_SAFE_INTEGER / 1000;
  if (placed >= expectedPoolSize(variant) - 1) return Math.max(timeout, FULL_BOARD_TIMEOUT_SEC);
  return timeout;
}

function playOneRun(
  args: CliArgs,
  placed: number,
  seed: number,
  log: Transcript
): { ok: boolean; puzzle: Puzzle | null } {
  const timeoutMs = genTimeoutSec(placed, args.variant, args.timeout) * 1000;
  const rng = makeRng(seed);

  const result = generateSolvedBoard(rng, placed, args.variant, timeoutMs);
  const puzzle = result.puzzle;
  const board = puzzle?.placedCount ?? 0;
  const match = result.ok && puzzle != null && board === placed;

  log.sessionStart({
    seed,
    placed: String(placed),
    board,
    rack: puzzle?.rackCount ?? 0,
    genMs: result.elapsedMs
  });

  if (!match) {
    if (result.timedOut && result.partial) {
      log.timeout({
        elapsedMs: result.elapsedMs,
        target: result.partial.target,
        placed: result.partial.placed,
        meldCount: result.partial.meldCount,
        attempts: result.partial.attempts
      });
    }
    log.note(`[FAIL] placed=${placed} board=${board} (must match)`);
    return { ok: false, puzzle: null };
  }

  log.solvedBoard(puzzle!.grid, puzzle!.rack);

  let state: Puzzle = puzzle!;
  const originalMelds = state.melds;

  if (args.remove != null) {
    const removed = removePercentFromBoard(state.grid, [], state.melds, args.remove, rng);
    log.separator();
    log.removed(args.remove, removed.removed, removed.grid, removed.rack);
    const rackAfterRemove = [...removed.rack];
    state = {
      ...state,
      grid: removed.grid,
      rack: rackAfterRemove,
      placedCount: gridTileCount(removed.grid),
      rackCount: rackAfterRemove.length
    };
    log.separator();
    const playerStart = runBoardSolve(removed.grid, rackAfterRemove, rng, log, { originalMelds });
    log.separator();
    const audit = runAuditSolve(playerStart.grid, playerStart.rack, rng, log, { originalMelds });
    if (!audit.solved) {
      return { ok: false, puzzle: state };
    }
    state = {
      ...state,
      grid: audit.grid,
      rack: audit.rack,
      rackCount: audit.rack.length,
      placedCount: gridTileCount(audit.grid),
      melds: audit.usedKnownLayout ? originalMelds : state.melds
    };
  }

  return { ok: true, puzzle: state };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  if (!Number.isFinite(args.runs) || args.runs < 1) {
    console.error('error: --runs must be at least 1');
    return 1;
  }

  const placed = args.placed ?? defaultPlacedCount(args.variant);
  const placedErr = validatePlaced(placed, args.variant);
  if (placedErr) {
    console.error(placedErr);
    return 1;
  }

  if (args.remove != null) {
    const removeErr = validateRemove(args.remove);
    if (removeErr) {
      console.error(removeErr);
      return 1;
    }
  }

  const log = new Transcript(true);

  if (args.demo) {
    const result = demoResult();
    const puzzle = result.puzzle!;
    log.sessionStart({
      seed: 0,
      placed: String(puzzle.placedCount),
      board: puzzle.placedCount,
      rack: puzzle.rackCount,
      genMs: 0
    });
    log.solvedBoard(puzzle.grid, puzzle.rack);
    return 0;
  }

  let failures = 0;

  for (let run = 0; run < args.runs; run++) {
    if (args.runs > 1) log.note(`--- run ${run + 1}/${args.runs} ---`);
    const seed = runSeed(args.seed, run);
    const { ok } = playOneRun(args, placed, seed, log);
    if (!ok) failures++;
  }

  if (args.runs > 1) {
    log.note(
      failures === 0
        ? `[OK] ${args.runs} runs: placed=board=${placed} every time`
        : `[FAIL] ${failures}/${args.runs} runs failed`
    );
  }

  return failures > 0 ? 1 : 0;
}

const entry = process.argv[1];
const isMain = entry != null && fileURLToPath(import.meta.url) === resolve(entry);
if (isMain) process.exit(main());

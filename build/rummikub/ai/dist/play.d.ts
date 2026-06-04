#!/usr/bin/env node
/**
 * Rummikub puzzle terminal — generate solved board, optional removal, solve.
 *
 *   npx tsx src/play.ts --seed 42 --remove 30   # steps 1–4 (gen → remove → player start → audit)
 *   npx tsx src/play.ts --placed 106 --runs 3
 */
export declare function main(argv?: string[]): number;

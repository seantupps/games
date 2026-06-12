/** Browser bundle entry — built to games/rummikub/rummikub-core.js */
export { makeRng } from './rng.js';
export type { Rng } from './rng.js';
export { generateSolvedBoard } from './puzzle.js';
export type { Puzzle, GenerateResult } from './puzzle.js';
export { removePercentFromBoard, gridTileCount } from './remove.js';
export { solveBoardLayout } from './puzzle-game.js';
export {
  partitionBoardTiles,
  partitionIsSolved,
  meldsToGrid,
  verifyBoardPartition
} from './board-solver.js';
export type { VerifyPartitionResult } from './board-solver.js';
export { Grid } from './grid.js';
export { assignJokersToMeld, isValidMeld } from './validate.js';
export { sortRack, defaultPlacedCount } from './tiles.js';
export type { Tile, Color, Meld } from './types.js';

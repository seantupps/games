"use strict";
var RummikubCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/browser.ts
  var browser_exports = {};
  __export(browser_exports, {
    Grid: () => Grid,
    assignJokersToMeld: () => assignJokersToMeld,
    defaultPlacedCount: () => defaultPlacedCount,
    generateSolvedBoard: () => generateSolvedBoard,
    gridTileCount: () => gridTileCount,
    isValidMeld: () => isValidMeld,
    makeRng: () => makeRng,
    meldsToGrid: () => meldsToGrid,
    partitionBoardTiles: () => partitionBoardTiles,
    partitionIsSolved: () => partitionIsSolved,
    removePercentFromBoard: () => removePercentFromBoard,
    solveBoardLayout: () => solveBoardLayout,
    sortRack: () => sortRack,
    verifyBoardPartition: () => verifyBoardPartition
  });

  // src/rng.ts
  function makeRng(seed) {
    let s = seed >>> 0;
    const next = () => {
      s += 1831565813;
      let t = s;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    return {
      randrange(n) {
        return Math.floor(next() * n);
      },
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      }
    };
  }

  // src/types.ts
  var COLORS = ["B", "R", "U", "O"];

  // src/tiles.ts
  function defaultPlacedCount(variant = "standard") {
    return buildPool(variant).length;
  }
  function copiesPerFace(variant) {
    return variant === "xp" ? 3 : 2;
  }
  function jokerCount(variant) {
    return variant === "xp" ? 4 : 2;
  }
  var nextId = 0;
  function resetIds() {
    nextId = 0;
  }
  function makeNumberTile(color, value) {
    return { kind: "number", color, value, id: `t${nextId++}` };
  }
  function makeJoker(display) {
    return { kind: "joker", id: `t${nextId++}`, display };
  }
  function buildPool(variant = "standard") {
    resetIds();
    const pool = [];
    const copies = copiesPerFace(variant);
    for (const color of COLORS) {
      for (let value = 1; value <= 13; value++) {
        for (let c = 0; c < copies; c++) {
          pool.push(makeNumberTile(color, value));
        }
      }
    }
    const jokers = jokerCount(variant);
    const displays = variant === "xp" ? ["B", "R", "B", "R"] : ["B", "R"];
    for (let j = 0; j < jokers; j++) {
      pool.push(makeJoker(displays[j]));
    }
    return pool;
  }
  function sortRack(tiles) {
    return [...tiles].sort((a, b) => {
      if (a.kind === "joker" && b.kind !== "joker") return 1;
      if (b.kind === "joker" && a.kind !== "joker") return -1;
      if (a.kind === "joker" && b.kind === "joker") {
        if (a.display !== b.display) return a.display.localeCompare(b.display);
        return a.id.localeCompare(b.id);
      }
      const an = a;
      const bn = b;
      if (an.color !== bn.color) return an.color.localeCompare(bn.color);
      return an.value - bn.value;
    });
  }

  // src/validate.ts
  function assignJokersToMeld(meld) {
    return assignJokers(meld.tiles, meld.kind);
  }
  function assignJokers(tiles, kind) {
    const resolved = new Array(tiles.length);
    const jokerIdx = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t.kind === "joker") {
        jokerIdx.push(i);
        continue;
      }
      resolved[i] = { color: t.color, value: t.value };
    }
    if (!jokerIdx.length) {
      const ok = kind === "group" ? validateGroupResolved(resolved) : validateRunResolved(resolved);
      return ok ? resolved : null;
    }
    if (kind === "group") {
      const nums = resolved.filter((r) => r?.value != null).map((r) => r.value);
      if (!nums.length) return null;
      const n = nums[0];
      if (nums.some((v) => v !== n)) return null;
      const usedColors = new Set(resolved.filter((r) => r?.color).map((r) => r.color));
      if (usedColors.size !== nums.length) return null;
      const freeColors = COLORS.filter((c) => !usedColors.has(c));
      if (freeColors.length < jokerIdx.length) return null;
      let fi = 0;
      for (const ji of jokerIdx) {
        resolved[ji] = { color: freeColors[fi++], value: n };
      }
      return validateGroupResolved(resolved) ? resolved : null;
    }
    const anchors = resolved.map((r, i) => r?.color && r.value != null ? { i, color: r.color, value: r.value } : null).filter(Boolean);
    if (!anchors.length) return null;
    const color = anchors[0].color;
    if (anchors.some((a) => a.color !== color)) return null;
    const minAnchor = anchors.reduce((m, a) => a.value < m.value ? a : m, anchors[0]);
    const start = minAnchor.value - minAnchor.i;
    if (start < 1 || start + tiles.length - 1 > 13) return null;
    for (let i = 0; i < tiles.length; i++) {
      const need = start + i;
      const existing = resolved[i];
      if (existing?.value != null) {
        if (existing.value !== need || existing.color !== color) return null;
      } else {
        resolved[i] = { color, value: need };
      }
    }
    return validateRunResolved(resolved) ? resolved : null;
  }
  function validateGroupResolved(resolved) {
    if (resolved.length < 3 || resolved.length > 4) return false;
    const values = resolved.map((r) => r.value);
    if (values.some((v) => v == null)) return false;
    const n = values[0];
    if (!values.every((v) => v === n)) return false;
    const colors = resolved.map((r) => r.color);
    if (colors.some((c) => !c)) return false;
    return new Set(colors).size === colors.length;
  }
  function validateRunResolved(resolved) {
    if (resolved.length < 3) return false;
    const color = resolved[0]?.color;
    if (!color || resolved.some((r) => r.color !== color)) return false;
    for (let i = 1; i < resolved.length; i++) {
      const prev = resolved[i - 1]?.value;
      const cur = resolved[i]?.value;
      if (prev == null || cur == null || cur !== prev + 1) return false;
    }
    return true;
  }
  function isValidMeld(meld) {
    if (meld.tiles.length < 3) return false;
    const kind = meld.kind;
    return assignJokers(meld.tiles, kind) !== null;
  }

  // src/grid.ts
  var Grid = class _Grid {
    constructor() {
      __publicField(this, "cells", /* @__PURE__ */ new Map());
    }
    static key(x, y) {
      return `${x},${y}`;
    }
    get(x, y) {
      return this.cells.get(_Grid.key(x, y));
    }
    set(x, y, cell) {
      this.cells.set(_Grid.key(x, y), cell);
    }
    clone() {
      const g = new _Grid();
      for (const [k, v] of this.cells) {
        g.cells.set(k, { tile: v.tile, color: v.color, value: v.value });
      }
      return g;
    }
    bounds(padX = 1, padY = 1) {
      const keys = [...this.cells.keys()];
      if (!keys.length) {
        return { minX: 0, maxX: 7, minY: 0, maxY: 1 };
      }
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const k of keys) {
        const [x, y] = k.split(",").map(Number);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      return {
        minX: minX - padX,
        maxX: maxX + padX,
        minY: minY - padY,
        maxY: maxY + padY
      };
    }
    /** Place a meld horizontally starting at (startX, y). */
    placeMeldHorizontal(meld, startX, y) {
      const resolved = assignJokersToMeld(meld);
      if (!resolved) throw new Error("invalid meld for grid placement");
      resolved.forEach((r, i) => {
        this.set(startX + i, y, {
          tile: meld.tiles[i],
          color: r.color,
          value: r.value
        });
      });
    }
  };

  // src/meld-connect.ts
  function summarizeMeld(meld) {
    const assigned = assignJokersToMeld(meld);
    if (!assigned) return null;
    if (meld.kind === "run") {
      const values = assigned.map((a) => a.value);
      return {
        kind: "run",
        color: assigned[0].color,
        min: Math.min(...values),
        max: Math.max(...values)
      };
    }
    return {
      kind: "group",
      value: assigned[0].value,
      colors: new Set(assigned.map((a) => a.color))
    };
  }
  function meldsCanConnect(a, b) {
    if (a.kind === "run" && b.kind === "run") {
      if (a.color !== b.color) return false;
      return a.max + 1 >= b.min && b.max + 1 >= a.min;
    }
    if (a.kind === "group" && b.kind === "group") {
      if (a.value !== b.value) return false;
      for (const c of a.colors) {
        if (b.colors.has(c)) return false;
      }
      return a.colors.size + b.colors.size <= 4;
    }
    return false;
  }
  function canConnectToAny(candidate, existing) {
    const cs = summarizeMeld(candidate);
    if (!cs) return true;
    for (const e of existing) {
      const es = summarizeMeld(e);
      if (es && meldsCanConnect(cs, es)) return true;
    }
    return false;
  }
  function boardHasConnectablePair(melds) {
    const summaries = melds.map(summarizeMeld).filter(Boolean);
    for (let i = 0; i < summaries.length; i++) {
      for (let j = i + 1; j < summaries.length; j++) {
        if (meldsCanConnect(summaries[i], summaries[j])) return true;
      }
    }
    return false;
  }

  // src/board-gen.ts
  var GROUP_SIZES = [3, 4];
  var RUN_SIZES = [3, 4, 5, 6];
  var MELD_SIZES = [3, 4, 5, 6];
  function splitRack(rack) {
    const numbers = [];
    const jokers = [];
    for (const t of rack) {
      if (t.kind === "number") numbers.push(t);
      else jokers.push(t);
    }
    return { numbers, jokers };
  }
  function isAchievableTarget(n) {
    if (n < 0) return false;
    if (n === 0) return true;
    const dp = new Array(n + 1).fill(false);
    dp[0] = true;
    for (let i = 3; i <= n; i++) {
      for (const s of MELD_SIZES) {
        if (i >= s && dp[i - s]) {
          dp[i] = true;
          break;
        }
      }
    }
    return dp[n] ?? false;
  }
  function sizeCompletesBudget(budget, size) {
    return isAchievableTarget(budget - size);
  }
  function tryBuildRun(numbers, jokers, color, start, len) {
    const seq = numbers.filter((t) => t.color === color);
    const need = Array.from({ length: len }, (_, i) => start + i);
    const picked = [];
    const used = /* @__PURE__ */ new Set();
    let ji = 0;
    for (const v of need) {
      const hit = seq.find((t) => t.value === v && !used.has(t.id));
      if (hit) {
        used.add(hit.id);
        picked.push(hit);
      } else if (ji < jokers.length) {
        used.add(jokers[ji].id);
        picked.push(jokers[ji]);
        ji++;
      } else {
        return null;
      }
    }
    const meld = { kind: "run", tiles: picked };
    return isValidMeld(meld) ? picked : null;
  }
  function tryBuildGroup(numbers, jokers, value, size) {
    const tiles = numbers.filter((t) => t.value === value);
    const byColor = /* @__PURE__ */ new Map();
    for (const t of tiles) {
      const list = byColor.get(t.color) ?? [];
      list.push(t);
      byColor.set(t.color, list);
    }
    const colors = [...byColor.keys()];
    if (colors.length + jokers.length < size) return null;
    const tryPick = (colorOrder) => {
      const picked = [];
      let ji = 0;
      for (const c of colorOrder) {
        if (picked.length >= size) break;
        const t = byColor.get(c)?.[0];
        if (!t) continue;
        picked.push(t);
      }
      while (picked.length < size && ji < jokers.length) {
        picked.push(jokers[ji]);
        ji++;
      }
      if (picked.length !== size) return null;
      const meld = { kind: "group", tiles: picked };
      return isValidMeld(meld) ? picked : null;
    };
    const direct = tryPick(colors);
    if (direct) return direct;
    if (colors.length >= size) {
      const perm = [...colors];
      for (let i = 0; i < 12; i++) {
        for (let j = perm.length - 1; j > 0; j--) {
          const k = i % (j + 1);
          [perm[j], perm[k]] = [perm[k], perm[j]];
        }
        const hit = tryPick(perm.slice(0, size));
        if (hit) return hit;
      }
    }
    return null;
  }
  function findMeldExactSize(rack, size, rng, onBoard = [], allowConnectable = false) {
    if (size < 3) return null;
    const { numbers, jokers } = splitRack(rack);
    if (size <= 6) {
      const colors = [...COLORS];
      rng.shuffle(colors);
      const starts = Array.from({ length: 11 }, (_, i) => i + 1);
      rng.shuffle(starts);
      for (const color of colors) {
        for (const start of starts) {
          if (start + size - 1 > 13) continue;
          const tiles = tryBuildRun(numbers, jokers, color, start, size);
          if (!tiles) continue;
          const meld = { kind: "run", tiles };
          if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
          return meld;
        }
      }
    }
    if (size <= 4) {
      const values = Array.from({ length: 13 }, (_, i) => i + 1);
      rng.shuffle(values);
      for (const value of values) {
        const tiles = tryBuildGroup(numbers, jokers, value, size);
        if (!tiles) continue;
        const meld = { kind: "group", tiles };
        if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
        return meld;
      }
    }
    return null;
  }
  function randomSizePlan(n, rng) {
    const plan = [];
    let left = n;
    while (left > 0) {
      const opts = MELD_SIZES.filter((s) => s <= left && isAchievableTarget(left - s));
      if (!opts.length) return [];
      opts.sort((a, b) => b - a);
      const pick = opts[rng.randrange(Math.min(3, opts.length))];
      plan.push(pick);
      left -= pick;
    }
    rng.shuffle(plan);
    return plan;
  }
  function fillBySizePlan(pool, plan, rng, allowConnectable) {
    const melds = [];
    let remaining = [...pool];
    for (const size of plan) {
      const meld = findMeldExactSize(remaining, size, rng, melds, allowConnectable);
      if (!meld) return null;
      const ids = new Set(meld.tiles.map((t) => t.id));
      remaining = remaining.filter((t) => !ids.has(t.id));
      melds.push(meld);
    }
    if (remaining.length !== 0) return null;
    return { melds, placed: pool.length, remaining: [] };
  }
  function meldSizeValid(meld) {
    const n = meld.tiles.length;
    if (meld.kind === "group") return n >= 3 && n <= 4;
    return n >= 3 && n <= 6;
  }
  function findFastMeld(rack, maxLen, rng, onBoard = [], allowConnectable = false, skipBudgetCheck = false) {
    if (maxLen < 3) return null;
    const { numbers, jokers } = splitRack(rack);
    const runSizes = RUN_SIZES.filter((s) => s <= Math.min(maxLen, 6));
    rng.shuffle(runSizes);
    const colors = [...COLORS];
    rng.shuffle(colors);
    for (const len of runSizes) {
      for (const color of colors) {
        const starts = Array.from({ length: 11 }, (_, i) => i + 1);
        rng.shuffle(starts);
        for (const start of starts) {
          if (start + len - 1 > 13) continue;
          const tiles = tryBuildRun(numbers, jokers, color, start, len);
          if (!tiles) continue;
          const meld = { kind: "run", tiles };
          if (!skipBudgetCheck && !sizeCompletesBudget(maxLen, len)) continue;
          if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
          return meld;
        }
      }
    }
    const groupSizes = GROUP_SIZES.filter((s) => s <= maxLen);
    rng.shuffle(groupSizes);
    const values = Array.from({ length: 13 }, (_, i) => i + 1);
    rng.shuffle(values);
    for (const value of values) {
      for (const size of groupSizes) {
        const tiles = tryBuildGroup(numbers, jokers, value, size);
        if (!tiles) continue;
        const meld = { kind: "group", tiles };
        if (!skipBudgetCheck && !sizeCompletesBudget(maxLen, size)) continue;
        if (!allowConnectable && canConnectToAny(meld, onBoard)) continue;
        return meld;
      }
    }
    return null;
  }
  function greedyFill(pool, target, rng, deadlineMs, allowConnectable = false) {
    const melds = [];
    let remaining = [...pool];
    let placed = 0;
    while (placed < target) {
      if (Date.now() >= deadlineMs) break;
      const budget = target - placed;
      if (budget === 0) break;
      if (budget < 3 || !isAchievableTarget(budget)) break;
      if (remaining.length < 3) break;
      const meld = findFastMeld(remaining, budget, rng, melds, allowConnectable);
      if (!meld) break;
      const ids = new Set(meld.tiles.map((t) => t.id));
      remaining = remaining.filter((t) => !ids.has(t.id));
      melds.push(meld);
      placed += meld.tiles.length;
    }
    return { melds, placed, remaining };
  }
  function greedyFillComplete(pool, rng, _deadlineMs, allowConnectable = false) {
    const plan = randomSizePlan(pool.length, rng);
    if (plan.length) {
      const planned = fillBySizePlan(pool, plan, rng, allowConnectable);
      if (planned) return planned;
    }
    const melds = [];
    let remaining = [...pool];
    while (remaining.length >= 3 && isAchievableTarget(remaining.length)) {
      const meld = findFastMeld(remaining, remaining.length, rng, melds, allowConnectable);
      if (!meld) break;
      const ids = new Set(meld.tiles.map((t) => t.id));
      remaining = remaining.filter((t) => !ids.has(t.id));
      melds.push(meld);
    }
    return {
      melds,
      placed: pool.length - remaining.length,
      remaining
    };
  }

  // src/layout.ts
  function layoutMelds(grid, melds) {
    melds.forEach((meld, i) => {
      grid.placeMeldHorizontal(meld, 0, i);
    });
  }

  // src/puzzle.ts
  var DEFAULT_TIMEOUT_MS = 3e3;
  function buildPuzzle(pool, melds, target, strictConnect) {
    if (melds.some((m) => !meldSizeValid(m))) return null;
    if (strictConnect && boardHasConnectablePair(melds)) return null;
    const grid = new Grid();
    layoutMelds(grid, melds);
    const placedCount = melds.reduce((s, m) => s + m.tiles.length, 0);
    return {
      grid,
      rack: [],
      melds,
      placedCount,
      rackCount: 0,
      placedRatio: placedCount / pool.length,
      targetCount: target
    };
  }
  function generateSolvedBoard(rng, placedCount = 53, variant = "standard", timeoutMs = DEFAULT_TIMEOUT_MS) {
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    const pool = buildPool(variant);
    const target = placedCount;
    const fullBoard = target === pool.length;
    const strictConnect = !fullBoard;
    if (!isAchievableTarget(target)) {
      return {
        ok: false,
        timedOut: false,
        elapsedMs: 0,
        puzzle: null,
        partial: {
          target,
          placed: 0,
          meldCount: 0,
          attempts: 0,
          melds: [],
          grid: new Grid(),
          rack: []
        }
      };
    }
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
      const work = [...pool];
      rng.shuffle(work);
      const { melds, placed, remaining } = fullBoard ? greedyFillComplete(work, rng, deadline, true) : { ...greedyFill(work, target, rng, deadline, false), remaining: [] };
      if (fullBoard) {
        if (remaining.length !== 0) continue;
      } else if (placed !== target) {
        continue;
      }
      const puzzle = buildPuzzle(pool, melds, target, strictConnect);
      if (!puzzle || puzzle.placedCount !== target) continue;
      return {
        ok: true,
        timedOut: false,
        elapsedMs: Date.now() - t0,
        puzzle,
        partial: null
      };
    }
    const elapsedMs = Date.now() - t0;
    return {
      ok: false,
      timedOut: true,
      elapsedMs,
      puzzle: null,
      partial: {
        target,
        placed: 0,
        meldCount: 0,
        attempts,
        melds: [],
        grid: new Grid(),
        rack: []
      }
    };
  }

  // src/remove.ts
  var FALLBACK_WEIGHT = 1;
  var RUN_END_WEIGHT = 1;
  var RUN_MIDDLE_BONUS = 2;
  function meldKey(meld) {
    return meld.tiles.map((t) => t.id).sort().join("|");
  }
  function boardTileIds(grid) {
    return new Set([...grid.cells.values()].map((c) => c.tile.id));
  }
  function findCellKey(grid, tileId) {
    for (const [key, cell] of grid.cells) {
      if (cell.tile.id === tileId) return key;
    }
    return null;
  }
  function removalBreaksMeld(meld, tileId) {
    const remaining = meld.tiles.filter((t) => t.id !== tileId);
    if (remaining.length < 3) return true;
    return !isValidMeld({ kind: meld.kind, tiles: remaining });
  }
  function runTileRemovalWeight(index, len) {
    if (len <= 2) return RUN_END_WEIGHT;
    const center = (len - 1) / 2;
    const dist = Math.abs(index - center);
    const maxDist = Math.max(center, 1);
    const middleScore = 1 - dist / maxDist;
    return RUN_END_WEIGHT + middleScore * RUN_MIDDLE_BONUS;
  }
  function meldTileRemovalWeight(meld, tileId) {
    if (removalBreaksMeld(meld, tileId)) {
      let weight = 1e3 + meld.tiles.length;
      if (meld.kind === "run") {
        const idx2 = meld.tiles.findIndex((t) => t.id === tileId);
        weight += runTileRemovalWeight(idx2, meld.tiles.length);
      }
      return weight;
    }
    if (meld.kind === "group") {
      return 800 + meld.tiles.length * 10;
    }
    const idx = meld.tiles.findIndex((t) => t.id === tileId);
    const len = meld.tiles.length;
    const trimWeight = 600 + len * 5;
    return trimWeight + runTileRemovalWeight(idx, len);
  }
  function findBoardMelds(grid) {
    const melds = [];
    const seenH = /* @__PURE__ */ new Set();
    const seenV = /* @__PURE__ */ new Set();
    for (const key of grid.cells.keys()) {
      const [x, y] = key.split(",").map(Number);
      const hStart = `h,${y},${x}`;
      if (!seenH.has(hStart) && !grid.get(x - 1, y)) {
        const tiles = [];
        let cx = x;
        while (true) {
          const cell = grid.get(cx, y);
          if (!cell) break;
          tiles.push(cell.tile);
          seenH.add(`h,${y},${cx}`);
          cx++;
        }
        if (tiles.length >= 3) {
          const run = { kind: "run", tiles };
          const grp = { kind: "group", tiles };
          if (isValidMeld(run)) melds.push(run);
          else if (isValidMeld(grp)) melds.push(grp);
        }
      }
      const vStart = `v,${x},${y}`;
      if (!seenV.has(vStart) && !grid.get(x, y - 1)) {
        const tiles = [];
        let cy = y;
        while (true) {
          const cell = grid.get(x, cy);
          if (!cell) break;
          tiles.push(cell.tile);
          seenV.add(`v,${x},${cy}`);
          cy++;
        }
        if (tiles.length >= 3) {
          const run = { kind: "run", tiles };
          const grp = { kind: "group", tiles };
          if (isValidMeld(run)) melds.push(run);
          else if (isValidMeld(grp)) melds.push(grp);
        }
      }
    }
    return melds;
  }
  function bestRemovalForMeld(meld, grid) {
    const keyForMeld = meldKey(meld);
    let best = null;
    let onlyBreaking = false;
    for (const t of meld.tiles) {
      const key = findCellKey(grid, t.id);
      if (!key) continue;
      const breaks = removalBreaksMeld(meld, t.id);
      if (onlyBreaking && !breaks) continue;
      if (breaks && !onlyBreaking) {
        best = null;
        onlyBreaking = true;
      }
      const weight = meldTileRemovalWeight(meld, t.id);
      if (!best || weight > best.weight) {
        best = { key, weight, meldKey: keyForMeld };
      }
    }
    return best;
  }
  function intactMelds(melds, grid, touched) {
    const onBoard = boardTileIds(grid);
    return melds.filter(
      (m) => !touched.has(meldKey(m)) && m.tiles.every((t) => onBoard.has(t.id))
    );
  }
  function buildCandidates(grid, originalMelds, touchedMelds) {
    const out = [];
    for (const meld of intactMelds(originalMelds, grid, touchedMelds)) {
      const best = bestRemovalForMeld(meld, grid);
      if (best) out.push(best);
    }
    if (!out.length) {
      for (const meld of findBoardMelds(grid)) {
        if (touchedMelds.has(meldKey(meld))) continue;
        const best = bestRemovalForMeld(meld, grid);
        if (best) out.push(best);
      }
    }
    if (!out.length) {
      for (const key of grid.cells.keys()) {
        out.push({ key, weight: FALLBACK_WEIGHT, meldKey: null });
      }
    }
    return out;
  }
  function weightedPickIndex(candidates, rng) {
    let total = 0;
    for (const c of candidates) total += c.weight;
    let pick = rng.randrange(total);
    for (let i = 0; i < candidates.length; i++) {
      pick -= candidates[i].weight;
      if (pick < 0) return i;
    }
    return candidates.length - 1;
  }
  function removePercentFromBoard(grid, rack, melds, percent, rng) {
    const g = grid.clone();
    const r = [...rack];
    const keys = [...g.cells.keys()];
    if (!keys.length || percent <= 0) {
      return { grid: g, rack: r, removed: 0 };
    }
    const count = Math.max(1, Math.round(keys.length * percent / 100));
    const touchedMelds = /* @__PURE__ */ new Set();
    let removed = 0;
    while (removed < count && g.cells.size > 0) {
      const candidates = buildCandidates(g, melds, touchedMelds);
      const idx = weightedPickIndex(candidates, rng);
      const pick = candidates[idx];
      const cell = g.cells.get(pick.key);
      g.cells.delete(pick.key);
      r.push(cell.tile);
      if (pick.meldKey) touchedMelds.add(pick.meldKey);
      removed++;
    }
    return { grid: g, rack: sortRack(r), removed };
  }
  function gridTileCount(grid) {
    return grid.cells.size;
  }

  // src/partition-bias.ts
  var LONG_RUN_MIN = 4;
  var BASE_WEIGHT = 1;
  var GROUP_BREAK_BONUS = 0.45;
  var SUBRUN_PENALTY_PER_TILE = 0.35;
  var MIXED_SOURCE_BONUS = 0.9;
  function buildOriginalLongRuns(melds, minLen = LONG_RUN_MIN) {
    const out = [];
    for (const meld of melds) {
      if (meld.kind !== "run" || meld.tiles.length < minLen) continue;
      const assigned = assignJokersToMeld(meld);
      if (!assigned?.length) continue;
      const color = assigned[0].color;
      const values = assigned.map((a) => a.value);
      const start = Math.min(...values);
      out.push({
        color,
        start,
        len: meld.tiles.length,
        tileIds: meld.tiles.map((t) => t.id)
      });
    }
    return out;
  }
  function tileLongRunMembership(tileId, runs) {
    let n = 0;
    for (const run of runs) {
      if (run.tileIds.includes(tileId)) n++;
    }
    return n;
  }
  function isContiguousOriginalSubRun(meld, orig) {
    if (meld.kind !== "run" || meld.tiles.length < 3) return false;
    const assigned = assignJokersToMeld(meld);
    if (!assigned || assigned[0].color !== orig.color) return false;
    const values = assigned.map((a) => a.value);
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1] + 1) return false;
    }
    const indices = meld.tiles.map((t) => orig.tileIds.indexOf(t.id)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (indices.length !== meld.tiles.length) return false;
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1] + 1) return false;
    }
    return true;
  }
  function contiguousOriginalMatch(meld, runs) {
    for (const run of runs) {
      if (isContiguousOriginalSubRun(meld, run)) return run;
    }
    return null;
  }
  function meldPickWeight(meld, runs) {
    if (!runs.length) return BASE_WEIGHT;
    if (meld.kind === "group") {
      let bonus = 0;
      for (const t of meld.tiles) {
        if (tileLongRunMembership(t.id, runs) > 0) bonus += GROUP_BREAK_BONUS;
      }
      return BASE_WEIGHT + bonus;
    }
    const preserved = contiguousOriginalMatch(meld, runs);
    if (preserved) {
      return Math.max(0.3, BASE_WEIGHT - SUBRUN_PENALTY_PER_TILE * meld.tiles.length);
    }
    const sourceRuns = /* @__PURE__ */ new Set();
    for (const t of meld.tiles) {
      for (const run of runs) {
        if (run.tileIds.includes(t.id)) {
          sourceRuns.add(`${run.color}${run.start}`);
        }
      }
    }
    if (sourceRuns.size > 1) return BASE_WEIGHT + MIXED_SOURCE_BONUS;
    return BASE_WEIGHT;
  }
  function partitionPreservationScore(melds, runs) {
    let score = 0;
    for (const meld of melds) {
      if (meld.kind === "group") continue;
      const match = contiguousOriginalMatch(meld, runs);
      if (match) score += meld.tiles.length * meld.tiles.length;
    }
    return score;
  }
  function weightedPickMelds(items, weightFn, rng) {
    let total = 0;
    const weights = items.map((m) => {
      const w = weightFn(m);
      total += w;
      return w;
    });
    let pick = rng.randrange(total);
    for (let i = 0; i < items.length; i++) {
      pick -= weights[i];
      if (pick < 0) return items[i];
    }
    return items[items.length - 1];
  }

  // src/board-solver.ts
  var GREEDY_TOP_CANDIDATES = 8;
  var GROUP_SIZES2 = [3, 4];
  var MIN_RUN = 3;
  var MAX_RUN = 13;
  function splitPool(pool) {
    const numbers = [];
    const jokers = [];
    for (const t of pool) {
      if (t.kind === "number") numbers.push(t);
      else jokers.push(t);
    }
    return { numbers, jokers };
  }
  function tryBuildRun2(numbers, jokers, color, start, len) {
    const seq = numbers.filter((t) => t.color === color);
    const picked = [];
    const used = /* @__PURE__ */ new Set();
    let ji = 0;
    for (let v = start; v < start + len; v++) {
      const hit = seq.find((t) => t.value === v && !used.has(t.id));
      if (hit) {
        used.add(hit.id);
        picked.push(hit);
      } else if (ji < jokers.length) {
        used.add(jokers[ji].id);
        picked.push(jokers[ji]);
        ji++;
      } else {
        return null;
      }
    }
    const meld = { kind: "run", tiles: picked };
    return isValidMeld(meld) ? picked : null;
  }
  function tryBuildGroup2(numbers, jokers, value, size) {
    const tiles = numbers.filter((t) => t.value === value);
    const byColor = /* @__PURE__ */ new Map();
    for (const t of tiles) {
      const list = byColor.get(t.color) ?? [];
      list.push(t);
      byColor.set(t.color, list);
    }
    const colors = [...byColor.keys()];
    if (colors.length + jokers.length < size) return null;
    const tryPick = (order) => {
      const picked = [];
      let ji = 0;
      for (const c of order) {
        if (picked.length >= size) break;
        const t = byColor.get(c)?.[0];
        if (!t) continue;
        picked.push(t);
      }
      while (picked.length < size && ji < jokers.length) picked.push(jokers[ji]);
      if (picked.length !== size) return null;
      const meld = { kind: "group", tiles: picked };
      return isValidMeld(meld) ? picked : null;
    };
    const direct = tryPick(colors);
    if (direct) return direct;
    if (colors.length >= size) {
      const perm = [...colors];
      for (let i = 0; i < 24; i++) {
        for (let j = perm.length - 1; j > 0; j--) {
          const k = i % (j + 1);
          [perm[j], perm[k]] = [perm[k], perm[j]];
        }
        const hit = tryPick(perm.slice(0, size));
        if (hit) return hit;
      }
    }
    return null;
  }
  function meldKey2(meld) {
    return meld.tiles.map((t) => t.id).sort().join(",");
  }
  function poolKey(pool) {
    const counts = /* @__PURE__ */ new Map();
    for (const t of pool) {
      const k = t.kind === "joker" ? "J" : `${t.color}${t.value}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${n}`).join(",");
  }
  function enumerateMelds(pool, cap) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const { numbers, jokers } = splitPool(pool);
    const add = (meld) => {
      if (out.length >= cap) return;
      const key = meldKey2(meld);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(meld);
    };
    for (let len = MAX_RUN; len >= MIN_RUN; len--) {
      for (const color of COLORS) {
        for (let start = 1; start + len - 1 <= 13; start++) {
          const tiles = tryBuildRun2(numbers, jokers, color, start, len);
          if (tiles) add({ kind: "run", tiles });
          if (out.length >= cap) return out;
        }
      }
    }
    for (let value = 1; value <= 13; value++) {
      for (const size of GROUP_SIZES2) {
        const tiles = tryBuildGroup2(numbers, jokers, value, size);
        if (tiles) add({ kind: "group", tiles });
        if (out.length >= cap) return out;
      }
    }
    return out;
  }
  function removeTiles(pool, meld) {
    const ids = new Set(meld.tiles.map((t) => t.id));
    return pool.filter((t) => !ids.has(t.id));
  }
  function updateBest(best, melds, remaining, poolSize, longRuns) {
    const placed = poolSize - remaining.length;
    if (placed > best.placed) {
      return { melds: [...melds], remaining: [...remaining], placed };
    }
    if (placed < best.placed) return best;
    if (remaining.length < best.remaining.length) {
      return { melds: [...melds], remaining: [...remaining], placed };
    }
    if (remaining.length > best.remaining.length) return best;
    if (longRuns.length) {
      const nextPres = partitionPreservationScore(melds, longRuns);
      const bestPres = partitionPreservationScore(best.melds, longRuns);
      if (nextPres < bestPres) {
        return { melds: [...melds], remaining: [...remaining], placed };
      }
    }
    return best;
  }
  function backtrack(remaining, melds, deadlineMs, rng, poolSize, best, failed, longRuns) {
    if (remaining.length === 0) {
      return { melds: [...melds], remaining: [], placed: poolSize };
    }
    if (Date.now() >= deadlineMs) return best;
    best = updateBest(best, melds, remaining, poolSize, longRuns);
    if (remaining.length < MIN_RUN && remaining.length > 0) return best;
    const key = poolKey(remaining);
    if (failed.has(key)) return best;
    const cap = remaining.length <= 20 ? 80 : 40;
    const candidates = enumerateMelds(remaining, cap);
    if (!candidates.length) {
      failed.add(key);
      return best;
    }
    rng.shuffle(candidates);
    let result = best;
    for (const meld of candidates) {
      const next = removeTiles(remaining, meld);
      const hit = backtrack(next, [...melds, meld], deadlineMs, rng, poolSize, result, failed, longRuns);
      if (hit.placed === poolSize) return hit;
      if (hit.placed > result.placed) result = hit;
      else if (hit.placed === result.placed && longRuns.length) {
        const hitPres = partitionPreservationScore(hit.melds, longRuns);
        const resPres = partitionPreservationScore(result.melds, longRuns);
        if (hitPres < resPres) result = hit;
      }
    }
    failed.add(key);
    return result;
  }
  function pickGreedyMeld(candidates, longRuns, rng) {
    candidates.sort((a, b) => b.tiles.length - a.tiles.length);
    const pool = candidates.slice(0, Math.min(GREEDY_TOP_CANDIDATES, candidates.length));
    if (!longRuns.length || pool.length <= 1) return pool[rng.randrange(pool.length)];
    return weightedPickMelds(pool, (m) => meldPickWeight(m, longRuns), rng);
  }
  function partitionBoardTiles(pool, rng, deadlineMs, opts = {}) {
    const poolSize = pool.length;
    const longRuns = opts.originalMelds?.length ? buildOriginalLongRuns(opts.originalMelds) : [];
    let best = { melds: [], remaining: [...pool], placed: 0 };
    let attempts = 0;
    while (Date.now() < deadlineMs) {
      attempts++;
      let remaining = [...pool];
      rng.shuffle(remaining);
      const melds = [];
      while (remaining.length >= MIN_RUN) {
        const cands = enumerateMelds(remaining, 35);
        if (!cands.length) break;
        const pick = pickGreedyMeld(cands, longRuns, rng);
        melds.push(pick);
        remaining = removeTiles(remaining, pick);
      }
      best = updateBest(best, melds, remaining, poolSize, longRuns);
      if (best.placed === poolSize) break;
      if (attempts >= 40) break;
    }
    if (best.remaining.length > 0 && best.remaining.length <= 14 && Date.now() < deadlineMs) {
      const tail = backtrack(
        best.remaining,
        best.melds,
        deadlineMs,
        rng,
        poolSize,
        best,
        /* @__PURE__ */ new Set(),
        longRuns
      );
      if (tail.placed > best.placed) best = tail;
      else if (tail.placed === best.placed && longRuns.length) {
        const tailPres = partitionPreservationScore(tail.melds, longRuns);
        const bestPres = partitionPreservationScore(best.melds, longRuns);
        if (tailPres < bestPres) best = tail;
      }
      if (tail.placed === poolSize) best = tail;
    }
    const grid = meldsToGrid(best.melds);
    return { result: best, grid, attempts };
  }
  function partitionIsSolved(result) {
    return result.remaining.length === 0 && result.melds.length > 0;
  }
  function sortCandidatesDeterministic(candidates) {
    return [...candidates].sort((a, b) => {
      const d = b.tiles.length - a.tiles.length;
      if (d !== 0) return d;
      return meldKey2(a).localeCompare(meldKey2(b));
    });
  }
  function searchFullPartition(remaining, melds, deadlineMs, poolSize, failed) {
    if (remaining.length === 0) {
      return { melds: [...melds], remaining: [], placed: poolSize };
    }
    if (Date.now() >= deadlineMs) return null;
    if (remaining.length < MIN_RUN) return null;
    const key = poolKey(remaining);
    if (failed.has(key)) return null;
    const candidates = sortCandidatesDeterministic(enumerateMelds(remaining, 80));
    if (!candidates.length) {
      failed.add(key);
      return null;
    }
    for (const meld of candidates) {
      const hit = searchFullPartition(
        removeTiles(remaining, meld),
        [...melds, meld],
        deadlineMs,
        poolSize,
        failed
      );
      if (hit) return hit;
    }
    failed.add(key);
    return null;
  }
  var VERIFY_SEEDS = [0, 1, 7, 13, 42, 99, 12345, 99991];
  function verifyBoardPartition(pool, deadlineMs) {
    const t0 = Date.now();
    const emptyResult = {
      solved: false,
      result: { melds: [], remaining: [], placed: 0 },
      elapsedMs: 0,
      timedOut: false,
      method: "empty",
      seedAttempts: 0,
      partitionAttempts: 0
    };
    if (!pool.length) return emptyResult;
    let seedAttempts = 0;
    let partitionAttempts = 0;
    let best = { melds: [], remaining: [...pool], placed: 0 };
    for (const seed of VERIFY_SEEDS) {
      if (Date.now() >= deadlineMs) break;
      seedAttempts++;
      const rng = makeRng(seed);
      const slice = Math.max(280, Math.floor((deadlineMs - Date.now()) / (VERIFY_SEEDS.length - seedAttempts + 2)));
      const { result, attempts } = partitionBoardTiles(pool, rng, Date.now() + slice, {});
      partitionAttempts += attempts;
      if (partitionIsSolved(result)) {
        return {
          solved: true,
          result,
          elapsedMs: Date.now() - t0,
          timedOut: false,
          method: "partition-seeds",
          seedAttempts,
          partitionAttempts
        };
      }
      if (result.placed > best.placed || result.placed === best.placed && result.remaining.length < best.remaining.length) {
        best = result;
      }
    }
    if (Date.now() < deadlineMs) {
      const tail = best.remaining.length > 0 && best.remaining.length <= pool.length ? [...best.remaining] : [...pool];
      const melds = best.remaining.length > 0 && best.remaining.length < pool.length ? [...best.melds] : [];
      const hit = searchFullPartition(tail, melds, deadlineMs, pool.length, /* @__PURE__ */ new Set());
      if (hit && partitionIsSolved(hit)) {
        return {
          solved: true,
          result: hit,
          elapsedMs: Date.now() - t0,
          timedOut: false,
          method: "backtrack",
          seedAttempts,
          partitionAttempts
        };
      }
      if (hit && hit.placed > best.placed) best = hit;
    }
    const timedOut = Date.now() >= deadlineMs;
    return {
      solved: partitionIsSolved(best),
      result: best,
      elapsedMs: Date.now() - t0,
      timedOut,
      method: "exhausted",
      seedAttempts,
      partitionAttempts
    };
  }
  function meldsToGrid(melds) {
    const g = new Grid();
    layoutMelds(g, melds);
    return g;
  }
  function countMeldedTiles(melds) {
    return melds.reduce((s, m) => s + m.tiles.length, 0);
  }
  function layoutStats(melds, remaining) {
    const melded = countMeldedTiles(melds);
    return {
      melded,
      orphans: remaining.length,
      fragments: remaining.length > 0 ? 1 : 0,
      meldCount: melds.length
    };
  }

  // src/puzzle-game.ts
  function tilesFromGrid(grid) {
    return [...grid.cells.values()].map((c) => c.tile);
  }
  function solveBoardLayout(grid, rack, rng, opts = {}) {
    const { deadlineMs = 2e3 } = opts;
    const t0 = Date.now();
    const pool = tilesFromGrid(grid);
    const { result, grid: meldedGrid, attempts } = partitionBoardTiles(pool, rng, t0 + deadlineMs, {
      originalMelds: opts.originalMelds
    });
    const stats = layoutStats(result.melds, result.remaining);
    const elapsedMs = Date.now() - t0;
    const solved = partitionIsSolved(result);
    const rackWithOrphans = sortRack([...rack, ...result.remaining]);
    return {
      solved,
      attempts,
      elapsedMs,
      grid: meldedGrid,
      rack: rackWithOrphans,
      fragments: stats.fragments,
      orphanTiles: stats.orphans,
      boardTiles: pool.length,
      meldedTiles: stats.melded
    };
  }
  return __toCommonJS(browser_exports);
})();

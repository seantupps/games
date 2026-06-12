/**

 * Minimal solver grid — one meld per row.

 * Player-visible spacing is applied in games/rummikub/grid.js from rules.js.

 */
export function layoutMelds(grid, melds) {
    melds.forEach((meld, i) => {
        grid.placeMeldHorizontal(meld, 0, i);
    });
}
//# sourceMappingURL=layout.js.map
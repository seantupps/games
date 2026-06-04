/** Lay melds horizontally, one per row (Bananagrams-style). */
export function layoutMelds(grid, melds) {
    let rowY = 0;
    for (const meld of melds) {
        grid.placeMeldHorizontal(meld, 2, rowY);
        rowY += 1;
    }
}
//# sourceMappingURL=layout.js.map
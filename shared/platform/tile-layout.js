/**
 * Shared tile hit-box expansion (mobile) — open edges only, not against neighbors.
 */
(function (global) {
    /**
     * @param {object} tile
     * @param {object[]} others
     * @param {number} stepX
     * @param {number} [stepY]
     */
    function tileConnectedSides(tile, others, stepX, stepY) {
        const sy = stepY ?? stepX;
        let left = false;
        let right = false;
        let top = false;
        let bottom = false;
        for (const o of others) {
            if (!o || o.id === tile.id) continue;
            const dx = o.x - tile.x;
            const dy = o.y - tile.y;
            if (dx === -stepX && dy === 0) left = true;
            else if (dx === stepX && dy === 0) right = true;
            else if (dx === 0 && dy === -sy) top = true;
            else if (dx === 0 && dy === sy) bottom = true;
        }
        return { left, right, top, bottom };
    }

    /**
     * @param {object} tile
     * @param {object[]} others
     * @param {object} opts
     * @param {number} opts.pad
     * @param {number} opts.stepX
     * @param {number} [opts.stepY]
     */
    function computeHitExpand(tile, others, opts) {
        const pad = opts.pad || 0;
        if (!pad) return { left: 0, top: 0, right: 0, bottom: 0 };
        const sides = tileConnectedSides(tile, others, opts.stepX, opts.stepY ?? opts.stepX);
        return {
            left: sides.left ? 0 : pad,
            top: sides.top ? 0 : pad,
            right: sides.right ? 0 : pad,
            bottom: sides.bottom ? 0 : pad
        };
    }

    /**
     * @param {object} tile
     * @param {{ left: number, top: number, right: number, bottom: number }} hit
     * @param {number} faceW
     * @param {number} faceH
     */
    function tileElLayout(tile, hit, faceW, faceH) {
        return {
            left: Math.round(tile.x - hit.left),
            top: Math.round(tile.y - hit.top),
            width: faceW + hit.left + hit.right,
            height: faceH + hit.top + hit.bottom,
            faceLeft: hit.left,
            faceTop: hit.top
        };
    }

    global.TileLayout = {
        tileConnectedSides,
        computeHitExpand,
        tileElLayout
    };
})(typeof window !== 'undefined' ? window : global);

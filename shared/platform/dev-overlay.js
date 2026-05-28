/**
 * F6 dev overlay — viewport-center white dot + zoom readout (all games).
 */
(function (global) {
    function ensureElements() {
        let dot = document.getElementById('center-dot');
        if (!dot) {
            dot = document.createElement('div');
            dot.id = 'center-dot';
            document.body.appendChild(dot);
        }
        let debug = document.getElementById('debug-info');
        if (!debug) {
            debug = document.createElement('div');
            debug.id = 'debug-info';
            document.body.appendChild(debug);
        }
        return { dot, debug };
    }

    function sync(game) {
        const { dot, debug } = ensureElements();
        const on = !!game?.devMode;
        dot.style.display = on ? 'block' : 'none';
        debug.style.display = on ? 'block' : 'none';
        if (on) {
            const z = game.targetZoom ?? game.zoom ?? 1;
            debug.textContent = `Click board to focus | Zoom: ${Number(z).toFixed(2)} | Dev: ON`;
        }
    }

    const GameDevOverlay = { ensureElements, sync };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameDevOverlay;
    } else {
        global.GameDevOverlay = GameDevOverlay;
    }
})(typeof window !== 'undefined' ? window : global);

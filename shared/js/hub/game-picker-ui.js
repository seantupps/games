/**
 * Mount hub game/mode picker buttons from GameRegistry (add game in registry only).
 */
(function (global) {
    function modeLabel(mode) {
        if (mode === 'freestyle') return 'Freestyle';
        if (mode === 'classic') return 'Classic';
        return mode.charAt(0).toUpperCase() + mode.slice(1);
    }

    function mountGamePickerButtons() {
        const Registry = global.GameRegistry;
        const host = document.getElementById('game-picker-host');
        if (!host || !Registry) return;

        host.innerHTML = '';
        Registry.list().forEach((def) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'game-btn';
            btn.id = `btn-${def.id}`;
            btn.textContent = def.label;
            btn.addEventListener('click', () => {
                if (typeof global.setGame === 'function') global.setGame(def.id);
            });
            host.appendChild(btn);
        });
    }

    /** Rebuild mode toggle buttons for the active game (modes come from registry). */
    function syncModePicker(gameId, activeMode) {
        const Registry = global.GameRegistry;
        const host = document.getElementById('mode-picker-host');
        if (!host || !Registry) return;

        const def = Registry.get(gameId);
        host.innerHTML = '';
        if (!def || def.modes.length < 2) return;

        def.modes.forEach((mode) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toggle-btn';
            btn.id = `mode-${mode}`;
            btn.textContent = modeLabel(mode);
            if (mode === activeMode) btn.classList.add('active');
            btn.addEventListener('click', () => {
                if (typeof global.setGameMode === 'function') global.setGameMode(mode);
            });
            host.appendChild(btn);
        });
    }

    const HubGamePickerUI = { mountGamePickerButtons, syncModePicker };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = HubGamePickerUI;
    } else {
        global.HubGamePickerUI = HubGamePickerUI;
    }
})(typeof window !== 'undefined' ? window : global);

/**
 * Chrome-style HSV color picker for mobile (and optional desktop).
 * Saturation/value plane + hue strip + RGB fields.
 */
(function (global) {
    function clamp(n, lo, hi) {
        return Math.min(hi, Math.max(lo, n));
    }

    function rgbToHex(r, g, b) {
        const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
        return `#${h(r)}${h(g)}${h(b)}`;
    }

    function hexToRgb(hex) {
        const h = (hex || '#000000').replace('#', '');
        if (h.length !== 6) return { r: 0, g: 0, b: 0 };
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
        };
    }

    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        const v = max;
        const s = max === 0 ? 0 : d / max;
        if (d !== 0) {
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
                case g: h = ((b - r) / d + 2); break;
                default: h = ((r - g) / d + 4); break;
            }
            h /= 6;
        }
        return { h: h * 360, s, v };
    }

    function hsvToRgb(h, s, v) {
        h = ((h % 360) + 360) % 360;
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let rp = 0; let gp = 0; let bp = 0;
        if (h < 60) { rp = c; gp = x; }
        else if (h < 120) { rp = x; gp = c; }
        else if (h < 180) { gp = c; bp = x; }
        else if (h < 240) { gp = x; bp = c; }
        else if (h < 300) { rp = x; bp = c; }
        else { rp = c; bp = x; }
        return {
            r: Math.round((rp + m) * 255),
            g: Math.round((gp + m) * 255),
            b: Math.round((bp + m) * 255)
        };
    }

    function parseColor(hex) {
        const rgb = hexToRgb(hex);
        return rgbToHsv(rgb.r, rgb.g, rgb.b);
    }

    let root = null;
    let svCanvas = null;
    let hueCanvas = null;
    let svCtx = null;
    let hueCtx = null;
    let previewEl = null;
    let rgbInputs = null;
    let openState = null;

    function ensureDom() {
        if (root) return;
        root = document.createElement('div');
        root.className = 'five-color-picker';
        root.id = 'five-color-picker';
        root.hidden = true;
        root.innerHTML = `
            <div class="five-color-picker__backdrop" data-dismiss="1"></div>
            <div class="five-color-picker__panel" role="dialog" aria-label="Select color">
                <canvas class="five-color-picker__sv" width="280" height="168"></canvas>
                <div class="five-color-picker__controls">
                    <div class="five-color-picker__preview" aria-hidden="true"></div>
                    <canvas class="five-color-picker__hue" width="220" height="16"></canvas>
                </div>
                <div class="five-color-picker__rgb">
                    <label><span>R</span><input type="number" min="0" max="255" data-ch="r" inputmode="numeric"></label>
                    <label><span>G</span><input type="number" min="0" max="255" data-ch="g" inputmode="numeric"></label>
                    <label><span>B</span><input type="number" min="0" max="255" data-ch="b" inputmode="numeric"></label>
                </div>
            </div>`;
        document.body.appendChild(root);
        svCanvas = root.querySelector('.five-color-picker__sv');
        hueCanvas = root.querySelector('.five-color-picker__hue');
        svCtx = svCanvas.getContext('2d');
        hueCtx = hueCanvas.getContext('2d');
        previewEl = root.querySelector('.five-color-picker__preview');
        rgbInputs = [...root.querySelectorAll('.five-color-picker__rgb input')];

        const backdrop = root.querySelector('[data-dismiss]');
        let backdropDownId = null;
        backdrop.addEventListener('pointerdown', (e) => {
            if (e.target !== backdrop) return;
            backdropDownId = e.pointerId;
        });
        backdrop.addEventListener('pointerup', (e) => {
            if (e.target !== backdrop || e.pointerId !== backdropDownId) return;
            backdropDownId = null;
            close(true);
        });
        backdrop.addEventListener('pointercancel', () => { backdropDownId = null; });
        rgbInputs.forEach((input) => {
            input.addEventListener('input', () => {
                if (!openState) return;
                const r = clamp(+rgbInputs[0].value || 0, 0, 255);
                const g = clamp(+rgbInputs[1].value || 0, 0, 255);
                const b = clamp(+rgbInputs[2].value || 0, 0, 255);
                setHsv(rgbToHsv(r, g, b), true);
            });
        });

        bindDrag(svCanvas, (x, y, w, h) => {
            setHsv({
                h: openState.h,
                s: clamp(x / w, 0, 1),
                v: clamp(1 - y / h, 0, 1)
            }, true);
        });
        bindDrag(hueCanvas, (x, _y, w) => {
            setHsv({ h: clamp(x / w, 0, 1) * 360, s: openState.s, v: openState.v }, true);
        });
    }

    function bindDrag(canvas, onMove) {
        let active = false;
        const move = (e) => {
            if (!active || !openState) return;
            const r = canvas.getBoundingClientRect();
            const x = clamp(e.clientX - r.left, 0, r.width);
            const y = clamp(e.clientY - r.top, 0, r.height);
            onMove(x, y, r.width, r.height);
        };
        const end = () => {
            active = false;
            canvas.releasePointerCapture?.(canvas._ptrId);
        };
        canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            active = true;
            canvas._ptrId = e.pointerId;
            canvas.setPointerCapture?.(e.pointerId);
            move(e);
        });
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
    }

    function drawHueBar() {
        const w = hueCanvas.width;
        const h = hueCanvas.height;
        const g = hueCtx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, '#f00');
        g.addColorStop(0.17, '#ff0');
        g.addColorStop(0.33, '#0f0');
        g.addColorStop(0.5, '#0ff');
        g.addColorStop(0.67, '#00f');
        g.addColorStop(0.83, '#f0f');
        g.addColorStop(1, '#f00');
        hueCtx.fillStyle = g;
        hueCtx.fillRect(0, 0, w, h);
    }

    function drawSvPlane(h) {
        const w = svCanvas.width;
        const hPx = svCanvas.height;
        const pure = hsvToRgb(h, 1, 1);
        const gradH = svCtx.createLinearGradient(0, 0, w, 0);
        gradH.addColorStop(0, '#fff');
        gradH.addColorStop(1, `rgb(${pure.r},${pure.g},${pure.b})`);
        svCtx.fillStyle = gradH;
        svCtx.fillRect(0, 0, w, hPx);
        const gradV = svCtx.createLinearGradient(0, 0, 0, hPx);
        gradV.addColorStop(0, 'rgba(0,0,0,0)');
        gradV.addColorStop(1, '#000');
        svCtx.fillStyle = gradV;
        svCtx.fillRect(0, 0, w, hPx);
    }

    function drawMarkers() {
        if (!openState) return;
        drawSvPlane(openState.h);
        drawHueBar();
        const svW = svCanvas.width;
        const svH = svCanvas.height;
        const hx = hueCanvas.width;
        const hy = hueCanvas.height;
        const sx = openState.s * svW;
        const sy = (1 - openState.v) * svH;
        const hueX = (openState.h / 360) * hx;

        svCtx.beginPath();
        svCtx.arc(sx, sy, 7, 0, Math.PI * 2);
        svCtx.strokeStyle = '#fff';
        svCtx.lineWidth = 2;
        svCtx.stroke();
        svCtx.beginPath();
        svCtx.arc(sx, sy, 7, 0, Math.PI * 2);
        svCtx.strokeStyle = 'rgba(0,0,0,0.35)';
        svCtx.lineWidth = 1;
        svCtx.stroke();

        hueCtx.beginPath();
        hueCtx.arc(hueX, hy / 2, 7, 0, Math.PI * 2);
        hueCtx.fillStyle = '#fff';
        hueCtx.fill();
        hueCtx.strokeStyle = 'rgba(0,0,0,0.35)';
        hueCtx.lineWidth = 1;
        hueCtx.stroke();
    }

    function currentHex() {
        const rgb = hsvToRgb(openState.h, openState.s, openState.v);
        return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    function syncRgbFields() {
        const rgb = hsvToRgb(openState.h, openState.s, openState.v);
        rgbInputs[0].value = rgb.r;
        rgbInputs[1].value = rgb.g;
        rgbInputs[2].value = rgb.b;
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        previewEl.style.background = hex;
    }

    function emitInput() {
        const hex = currentHex();
        openState.onInput?.(hex);
    }

    function setHsv(next, emit) {
        if (!openState) return;
        openState.h = next.h;
        openState.s = next.s;
        openState.v = next.v;
        drawMarkers();
        syncRgbFields();
        if (emit) emitInput();
    }

    function close(committed) {
        if (!root || !openState) return;
        root.hidden = true;
        const hex = currentHex();
        const cb = openState.onClose;
        openState = null;
        if (committed) cb?.(hex);
    }

    function open(opts = {}) {
        ensureDom();
        if (openState) close(true);
        const start = parseColor(opts.color || '#3b82f6');
        openState = {
            h: start.h,
            s: start.s,
            v: start.v,
            onInput: opts.onInput,
            onClose: opts.onClose
        };
        drawHueBar();
        drawMarkers();
        syncRgbFields();
        root.hidden = false;
        global.muteHubOverlayDismiss?.(450);
        emitInput();
    }

    function shouldUseCustom(when) {
        if (typeof when === 'function') return !!when();
        if (when === 'always') return true;
        if (when === 'never') return false;
        return !!(global.FiveViewport?.isMobile?.() || global.FiveViewport?.isTouchPrimaryDevice?.());
    }

    function enhanceInput(input, opts = {}) {
        if (!input || input.type !== 'color') return;
        input.addEventListener('pointerdown', (e) => {
            if (!shouldUseCustom(opts.when)) return;
            e.preventDefault();
        });
        input.addEventListener('click', (e) => {
            if (!shouldUseCustom(opts.when)) return;
            e.preventDefault();
            e.stopPropagation();
            open({
                color: input.value || '#3b82f6',
                onInput: (hex) => {
                    input.value = hex;
                    opts.onInput?.(hex);
                },
                onClose: (hex) => {
                    input.value = hex;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    opts.onChange?.(hex);
                }
            });
        });
    }

    const ColorPicker = { open, close, enhanceInput, shouldUseCustom, hexToRgb, rgbToHex };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ColorPicker;
    } else {
        global.ColorPicker = ColorPicker;
    }
})(typeof window !== 'undefined' ? window : global);

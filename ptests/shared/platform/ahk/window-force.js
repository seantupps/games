/**
 * AutoHotkey — force Chrome outer window below ~500px minimum on Windows.
 * Used by headed mobile MP layout (see mp-headed-view.js).
 *
 * Set HEADED_AHK_ENABLED = true to retry AHK window forcing.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

/** Master toggle — flip to true to re-enable AHK mobile window forcing. */
const HEADED_AHK_ENABLED = false;

const DEFAULT_AHK_EXE = 'D:\\Tools\\AutoHotkey\\v2\\AutoHotkey64.exe';
const DEFAULT_AHK_SCRIPT = path.join(__dirname, 'force-chrome-window-size.ahk');

function ahkPaths() {
    return {
        exe: process.env.FIVE_AHK_EXE || DEFAULT_AHK_EXE,
        script: process.env.FIVE_AHK_SCRIPT || DEFAULT_AHK_SCRIPT
    };
}

function isAhkInstalled() {
    try {
        return fs.existsSync(ahkPaths().exe) && fs.existsSync(ahkPaths().script);
    } catch {
        return false;
    }
}

/** Unique title tag per headed mobile player slot (AHK finds window by substring). */
function headedMobileWindowTag(slotIndex) {
    return `FIVE_MP_HEADED_P${slotIndex + 1}`;
}

/** Headed mobile-only AHK resize (never used for desktop headed layout). */
function shouldAhkForceMobileHeaded() {
    if (!HEADED_AHK_ENABLED) return false;
    const v = process.env.FIVE_AHK_FORCE_WINDOW;
    if (v === '0' || v === 'false') return false;
    if (v === '1' || v === 'true') return true;
    return isAhkInstalled();
}

/**
 * @param {object} options
 * @param {number} options.width - outer window width
 * @param {number} options.height - outer window height
 * @param {number} [options.left]
 * @param {number} [options.top]
 * @param {number} [options.pid]
 * @param {number} [options.index]
 * @param {string} [options.title]
 * @param {boolean} [options.active]
 * @param {{ left: number, top: number, width: number, height: number }} [options.matchRect]
 */
function forceChromeWindow(options = {}) {
    if (!HEADED_AHK_ENABLED) return '';
    const { exe, script } = ahkPaths();
    const {
        width,
        height,
        left,
        top,
        pid,
        index,
        title,
        active,
        matchRect
    } = options;

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        throw new Error('forceChromeWindow requires width and height');
    }

    const args = [script, String(width), String(height)];
    if (Number.isFinite(left) && Number.isFinite(top)) {
        args.push(String(left), String(top));
    }
    if (matchRect) {
        args.push('--match',
            String(matchRect.left),
            String(matchRect.top),
            String(matchRect.width),
            String(matchRect.height));
    } else if (pid) {
        args.push('--pid', String(pid));
        if (Number.isFinite(index)) args.push('--index', String(index));
    } else if (title) {
        args.push('--title', title);
    } else if (active) {
        args.push('--active');
    } else {
        throw new Error('forceChromeWindow requires matchRect, pid, title, or active');
    }

    const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 15000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.error) {
        throw new Error(`AHK spawn failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(output || `AHK exited with code ${result.status}`);
    }
    return output;
}

/** Tag a page so AHK / headed layout can find its top-level window by title substring. */
async function markHeadedWindow(page, tag = 'FIVE_HEADED_WINDOW') {
    const marker = String(tag);
    await page.addInitScript((t) => {
        const apply = () => {
            try { document.title = t; } catch (_) { /* ignore */ }
        };
        apply();
        window.addEventListener('DOMContentLoaded', apply, { once: true });
    }, marker).catch(() => { });
    await page.evaluate((t) => {
        document.title = t;
    }, marker).catch(() => { });
    return marker;
}

module.exports = {
    HEADED_AHK_ENABLED,
    ahkPaths,
    headedMobileWindowTag,
    isAhkInstalled,
    shouldAhkForceMobileHeaded,
    forceChromeWindow,
    markHeadedWindow
};

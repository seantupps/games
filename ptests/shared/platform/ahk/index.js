/**
 * Headed mobile Chrome window force-resize (AutoHotkey, Windows only).
 *
 * Disabled by default — set HEADED_AHK_ENABLED = true in window-force.js to retry.
 *
 *   ahk/
 *     window-force.js              — Node bridge + toggle
 *     force-chrome-window-size.ahk — AHK v2 script
 */
module.exports = require('./window-force');

/** Desktop SP / headless MP canvas — headed MP splits width by player count. */
const DESKTOP_VIEWPORT = { width: 1920, height: 931 };

/** Emulated mobile viewport (Playwright inner / device preset). */
const MOBILE_VIEWPORT = { width: 412, height: 915 };

/** Headed mobile Chrome outer window (CDP bounds). */
const MOBILE_WINDOW = { width: 502, height: 996 };

module.exports = { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, MOBILE_WINDOW };

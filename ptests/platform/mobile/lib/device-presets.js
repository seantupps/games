/**
 * Playwright device presets for mobile emulation.
 * Real phone: npm run stack + npm run phone:lan:urls (see docs/PHONE_TESTING.md).
 */
const { devices } = require('playwright');

/** Galaxy S24+ class viewport (portrait-preferred; game supports both orientations). */
const GALAXY_S24_PLUS = {
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3.5,
    isMobile: true,
    hasTouch: true,
    userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
};

const PRESET_ALIASES = {
    iphone: 'iPhone 13',
    iphone13: 'iPhone 13',
    iphone14: 'iPhone 14',
    pixel: 'Pixel 5',
    pixel5: 'Pixel 5',
    galaxy: 'Galaxy S9+',
    galaxys24: '__galaxy_s24__',
    galaxys24plus: '__galaxy_s24__',
    s24: '__galaxy_s24__',
    ipad: 'iPad Pro 11'
};

function resolveDeviceName() {
    const raw = (process.env.FIVE_DEVICE || 'galaxys24').trim();
    const key = raw.toLowerCase().replace(/\s+/g, '');
    return PRESET_ALIASES[key] || raw;
}

function getDeviceContextOptions(overrides = {}) {
    const name = resolveDeviceName();
    if (name === '__galaxy_s24__') {
        return { ...GALAXY_S24_PLUS, locale: 'en-US', ...overrides };
    }
    const preset = devices[name];
    if (!preset) {
        const available = Object.keys(devices).filter((k) =>
            k.includes('iPhone') || k.includes('Pixel') || k.includes('Galaxy')).slice(0, 10);
        throw new Error(`Unknown FIVE_DEVICE "${name}". Examples: ${available.join(', ')}, galaxys24`);
    }
    return {
        ...preset,
        locale: 'en-US',
        hasTouch: true,
        isMobile: true,
        ...overrides
    };
}

module.exports = {
    resolveDeviceName,
    getDeviceContextOptions,
    PRESET_ALIASES
};

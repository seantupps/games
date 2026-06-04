/**
 * N-player helpers for multiplayer_base — backward compatible with page1/page2 APIs.
 */
const GameRegistry = require('../../../shared/games/registry');

const DEFAULT_PLAYERS_2 = [
    { uid: 'u_host_p1', name: 'HostP1', color: '#3b82f6', role: 'P1' },
    { uid: 'u_guest_p2', name: 'GuestP2', color: '#ef4444', role: 'P2' }
];

/**
 * @param {object} options
 * @returns {{ page: import('playwright').Page, role: string, context?: import('playwright').BrowserContext, isMobile: boolean, uid?: string, name?: string }[]}
 */
function resolveMpPlayerSlots(options = {}) {
    if (options.playerSlots?.length) {
        return options.playerSlots.map((s, i) => ({
            role: s.role || `P${i + 1}`,
            page: s.page,
            context: s.context,
            isMobile: !!s.isMobile,
            uid: s.uid,
            name: s.name,
            color: s.color
        }));
    }

    if (options.pages?.length) {
        const mobileFlags = options.isMobileSlot || [];
        return options.pages.map((page, i) => ({
            page,
            role: options.roles?.[i] || `P${i + 1}`,
            isMobile: mobileFlags[i] ?? !!options.isMobile,
            uid: options.playerDefs?.[i]?.uid,
            name: options.playerDefs?.[i]?.name,
            color: options.playerDefs?.[i]?.color
        }));
    }

    const p1 = options.page1;
    const p2 = options.page2;
    if (p1 && p2) {
        return [
            { page: p1, role: 'P1', context: options.context1, isMobile: !!options.isMobile },
            { page: p2, role: 'P2', context: options.context2, isMobile: !!options.isMobile }
        ];
    }

    return [];
}

/** @param {ReturnType<typeof resolveMpPlayerSlots>} slots */
function enrichMpContext(ctx, slots) {
    const pages = slots.map((s) => s.page);
    const isMobileSlot = slots.map((s) => s.isMobile);
    return {
        ...ctx,
        pages,
        playerSlots: slots,
        isMobileSlot,
        playerCount: slots.length,
        anyMobile: isMobileSlot.some(Boolean),
        isMobile: isMobileSlot.some(Boolean),
        pageFor(role) {
            return slots.find((s) => s.role === role)?.page;
        },
        isMobilePlayer(roleOrIndex) {
            if (typeof roleOrIndex === 'number') return !!isMobileSlot[roleOrIndex];
            const i = slots.findIndex((s) => s.role === roleOrIndex);
            return i >= 0 ? !!isMobileSlot[i] : false;
        },
        get page1() { return pages[0]; },
        get page2() { return pages[1]; }
    };
}

/**
 * Invoke beforeLoop whether it is (p1,p2,ctx) or (pages,ctx).
 * @param {Function} beforeLoop
 * @param {ReturnType<typeof resolveMpPlayerSlots>} slots
 * @param {object} ctx
 */
async function invokeBeforeLoop(beforeLoop, slots, ctx) {
    if (!beforeLoop) return;
    const merged = enrichMpContext(ctx, slots);
    const pages = merged.pages;

    if (slots.length > 2) {
        if (beforeLoop.length <= 1) {
            await beforeLoop(pages, merged);
        } else {
            await beforeLoop(pages[0], pages[1], merged);
        }
        return;
    }

    if (beforeLoop.length <= 1 && pages.length >= 2) {
        try {
            await beforeLoop(pages, merged);
            return;
        } catch (_) { /* fall through to 2-arg */ }
    }

    await beforeLoop(pages[0], pages[1], merged);
}

/**
 * @param {string} gameId
 * @param {string} [gameMode]
 */
function defaultMpSkipFlags(gameId, gameMode) {
    const { caps } = (() => {
        const mode = gameMode || GameRegistry.defaultModeFor(gameId);
        return { caps: GameRegistry.getCapabilities(gameId, mode) };
    })();

    return {
        skipPilesSync: caps.boardKind !== 'piles',
        skipPilesSelection: caps.boardKind !== 'piles' || !caps.supportsTurnIndicator,
        skipRefresh: caps.boardKind !== 'piles' || caps.syncStyle !== 'hybrid' || !caps.supportsTurnIndicator,
        skipLineDrag: caps.boardKind !== 'line' || !caps.supportsRealtimePreviews
    };
}

/**
 * Scenario-aware skip flags layered on registry caps.
 * @param {string} gameId
 * @param {string} [gameMode]
 * @param {string|string[]|null} [scenario]
 */
function mpScenarioSkipFlags(gameId, gameMode, scenario) {
    const base = defaultMpSkipFlags(gameId, gameMode);
    const { isSmokeScenario } = require('../scenarios/registry');
    if (!isSmokeScenario(scenario) && process.env.FIVE_MP_SLIM !== '1') {
        return base;
    }
    return {
        ...base,
        skipRefresh: true,
        skipPilesSelection: true
    };
}

/**
 * Optional registry-driven mobile MP extras module.
 */
async function runRegistryMobileMpExtras(page1, page2, gameId, ctx = {}) {
    const game = GameRegistry.get(gameId);
    const rel = game?.mobileMpExtras;
    if (!rel) return;
    const mod = require(require('path').join(require('path').resolve(__dirname, '../../..'), rel));
    const fn = mod.runMobileMpExtras || mod.default;
    if (typeof fn === 'function') {
        await fn(page1, page2, ctx);
    }
}

function playerDefsForCount(count, overrides = []) {
    const palette = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#ec4899'];
    const defs = [];
    for (let i = 0; i < count; i++) {
        const role = `P${i + 1}`;
        const base = DEFAULT_PLAYERS_2[i] || {
            uid: `u_mp_p${i + 1}`,
            name: `Player${i + 1}`,
            color: palette[i % palette.length],
            role
        };
        defs.push({ ...base, ...overrides[i], role });
    }
    return defs;
}

module.exports = {
    DEFAULT_PLAYERS_2,
    resolveMpPlayerSlots,
    enrichMpContext,
    invokeBeforeLoop,
    defaultMpSkipFlags,
    mpScenarioSkipFlags,
    runRegistryMobileMpExtras,
    playerDefsForCount
};

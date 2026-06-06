/**
 * Named scenario steps for composable game audits.
 */
const { logStep } = require('../adapters/desktop-input');

/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function runScenario(name, fn) {
    logStep(name);
    try {
        await fn();
        logStep(`SUCCESS: ${name}`);
    } catch (err) {
        const wrapped = new Error(`Scenario "${name}" failed: ${err.message}`);
        if (err.details) wrapped.details = err.details;
        if (err.stack) wrapped.stack = err.stack;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * Run scenarios in order; stops on first failure.
 * @param {Array<{ name: string, run: (ctx: object) => Promise<void> }>} scenarios
 * @param {object} [ctx]
 */
async function runScenarios(scenarios, ctx = {}) {
    for (const s of scenarios) {
        await runScenario(s.name, () => s.run(ctx));
    }
}

/**
 * Merge multiple beforeLoop hooks (capability checks + game-specific).
 * @param  {...(function(import('playwright').Page, object): Promise<void>)} fns
 */
function composeBeforeLoop(...fns) {
    return async (page, ctx = {}) => {
        for (const fn of fns) {
            if (typeof fn === 'function') await fn(page, ctx);
        }
    };
}

/** MP: run hooks on page1 then page2, or parallel when second arg is page2. */
function composeMpBeforeLoop(hostFn, guestFn) {
    return async (page1, page2, ctx = {}) => {
        if (hostFn) await hostFn(page1, { ...ctx, role: 'P1' });
        if (guestFn) await guestFn(page2, { ...ctx, role: 'P2' });
    };
}

function composeMpBeforeLoopParallel(fn) {
    return async (page1, page2, ctx = {}) => {
        await Promise.all([
            fn(page1, { ...ctx, role: 'P1' }),
            fn(page2, { ...ctx, role: 'P2' })
        ]);
    };
}

module.exports = {
    runScenario,
    runScenarios,
    composeBeforeLoop,
    composeMpBeforeLoop,
    composeMpBeforeLoopParallel
};

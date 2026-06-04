const { HUB_MS, runComponent } = require('./shared');
const { setupHubParty } = require('./party-setup');

async function waitForHubPiles(page, label, mode) {
    await page.waitForFunction(
        ({ m }) => {
            const frame = document.getElementById('game-frame');
            const game = frame?.contentWindow?.game;
            if (!game || game.gameName !== 'piles' || game.mode !== m) return false;
            const piles = game.piles || {};
            return piles.B && piles.B.length > 0;
        },
        { m: mode },
        { timeout: HUB_MS }
    ).catch(() => {
        throw new Error(`Timeout waiting for piles (${mode}) on ${label}`);
    });
}

async function getPilesState(page) {
    return page.evaluate(() => {
        const game = document.getElementById('game-frame')?.contentWindow?.game;
        const piles = game?.piles || {};
        return {
            mode: game?.mode,
            bCount: (piles.B || []).length,
            rCount: (piles.R || []).length,
            gCount: (piles.G || []).length
        };
    });
}

async function countVisiblePieces(page) {
    return page.evaluate(() => {
        const doc = document.getElementById('game-frame')?.contentWindow?.document;
        const pieces = doc ? [...doc.querySelectorAll('.piece')] : [];
        return pieces.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
        }).length;
    });
}

const spec = {
    id: 'host-mode-sync',
    name: 'Host mode switch syncs guest (visible piles, matching state)',
    async run(browser) {
        const party = await setupHubParty(browser);
        try {
            await waitForHubPiles(party.page1, 'host', 'classic');
            await waitForHubPiles(party.page2, 'guest', 'classic');

            const beforeHost = await getPilesState(party.page1);
            const beforeGuest = await getPilesState(party.page2);
            if (beforeHost.bCount !== beforeGuest.bCount) {
                throw new Error(`Classic pile mismatch before switch: host=${JSON.stringify(beforeHost)} guest=${JSON.stringify(beforeGuest)}`);
            }

            await party.page1.evaluate(() => window.setGameMode('freestyle'));

            await waitForHubPiles(party.page1, 'host', 'freestyle');
            await waitForHubPiles(party.page2, 'guest', 'freestyle');

            const afterHost = await getPilesState(party.page1);
            const afterGuest = await getPilesState(party.page2);
            if (afterHost.bCount !== afterGuest.bCount
                || afterHost.rCount !== afterGuest.rCount
                || afterHost.gCount !== afterGuest.gCount) {
                throw new Error(
                    `Freestyle mismatch after host switch: host=${JSON.stringify(afterHost)} guest=${JSON.stringify(afterGuest)}`
                );
            }

            const total = afterHost.bCount + afterHost.rCount + afterHost.gCount;
            if (total < 14 || total > 20) {
                throw new Error(`Expected 14–20 freestyle pieces, got ${total}`);
            }

            const waitVisiblePieces = async (page, label, min = 5) => {
                await page.waitForFunction(
                    (n) => {
                        const doc = document.getElementById('game-frame')?.contentWindow?.document;
                        const pieces = doc ? [...doc.querySelectorAll('.piece')] : [];
                        const vis = pieces.filter((el) => {
                            const r = el.getBoundingClientRect();
                            return r.width > 2 && r.height > 2;
                        }).length;
                        return vis >= n;
                    },
                    min,
                    { timeout: HUB_MS }
                ).catch(() => {
                    throw new Error(`${label} has too few visible pieces after mode switch`);
                });
            };

            await Promise.all([
                waitVisiblePieces(party.page1, 'Host'),
                waitVisiblePieces(party.page2, 'Guest')
            ]);
        } finally {
            await party.cleanup();
        }
    }
};

if (require.main === module) {
    runComponent(spec).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = spec;

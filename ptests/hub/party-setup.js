/**
 * Two-player hub party — delegates to shared hub-party (piles classic default).
 * @deprecated Prefer require('../shared/infra/hub-party').setupHubParty
 */
const { setupHubParty: setupHubPartyN } = require('../shared/infra/hub-party');
const { playerDefsForCount } = require('../shared/infra/mp-player-utils');

/**
 * @returns {{ roomId: string, page1, page2, ctx1, ctx2, cleanup: () => Promise<void> }}
 */
async function setupHubParty(browser, options = {}) {
    const players = options.players || playerDefsForCount(2, [
        { uid: options.uidHost || 'u_hub_host', name: 'HubHost', color: '#3b82f6', role: 'P1' },
        { uid: options.uidGuest || 'u_hub_guest', name: 'HubGuest', color: '#ef4444', role: 'P2' }
    ]);
    const gameId = options.gameId || 'piles';
    const gameMode = options.gameMode || 'classic';
    const party = await setupHubPartyN(browser, {
        gameId,
        gameMode,
        roomId: options.roomId,
        players,
        topology: 'desktop'
    });

    const { gotoPartyGameUrls } = require('../shared/infra/hub-party');
    await gotoPartyGameUrls(party);

    const { STEP_MS } = require('../shared/infra/timeouts');
    const waitMs = Number(process.env.FIVE_MP_PARTY_MS || STEP_MS);
    await Promise.all([
        party.pages[0].waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.piles?.B?.length > 0;
        }, { timeout: waitMs }),
        party.pages[1].waitForFunction(() => {
            const g = document.getElementById('game-frame')?.contentWindow?.game;
            return g?.piles?.B?.length > 0;
        }, { timeout: waitMs })
    ]);

    return {
        roomId: party.roomId,
        page1: party.pages[0],
        page2: party.pages[1],
        ctx1: party.session.contexts[0],
        ctx2: party.session.contexts[1],
        cleanup: party.cleanup
    };
}

module.exports = { setupHubParty };

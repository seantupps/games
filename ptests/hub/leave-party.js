const { openHubLobby, launchDesktopBrowser, runComponent, HUB_MS } = require('./shared');
const { setupHubParty } = require('./party-setup');

async function isLeavePartyVisible(page) {
    await page.keyboard.press('s');
    await page.waitForFunction(
        () => document.getElementById('settings-sidebar')?.classList.contains('open'),
        { timeout: HUB_MS }
    );
    return page.evaluate(() => {
        const btn = document.getElementById('btn-leave-party');
        return !!(btn && getComputedStyle(btn).display !== 'none');
    });
}

const spec = {
    id: 'leave-party',
    name: 'Leave party button (hidden in lobby, visible in party)',
    async run(browser) {
        const { context, page } = await launchDesktopBrowser(browser);
        try {
            await openHubLobby(page, 'HubLeavePartyTest');
            const hiddenInLobby = await isLeavePartyVisible(page);
            if (hiddenInLobby) {
                throw new Error('Leave party should be hidden in lobby');
            }
            await page.keyboard.press('s');
        } finally {
            await context.close().catch(() => {});
        }

        const party = await setupHubParty(browser);
        try {
            const visibleHost = await isLeavePartyVisible(party.page1);
            const visibleGuest = await isLeavePartyVisible(party.page2);
            if (!visibleHost) {
                throw new Error('Leave party should be visible for host in party');
            }
            if (!visibleGuest) {
                throw new Error('Leave party should be visible for guest in party');
            }
        } finally {
            await party.cleanup();
        }
    }
};

if (require.main === module) {
    runComponent(spec).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = spec;

const { HUB_MS, runComponent } = require('./shared');
const { setupHubParty } = require('./party-setup');

async function runInviteFlow(browser) {
    const party = await setupHubParty(browser);
    try {
        await Promise.all([
            party.page1.waitForFunction(
                () =>
                    getComputedStyle(document.documentElement).getPropertyValue('--opponent-color')
                        .trim()
                        .toLowerCase() === '#ef4444',
                { timeout: HUB_MS }
            ),
            party.page2.waitForFunction(
                () =>
                    getComputedStyle(document.documentElement).getPropertyValue('--opponent-color')
                        .trim()
                        .toLowerCase() === '#3b82f6',
                { timeout: HUB_MS }
            )
        ]);
    } finally {
        await party.cleanup();
    }
}

const spec = {
    id: 'invite',
    name: 'Invite flow (lobby until accept, MP colors)',
    async run(browser) {
        await runInviteFlow(browser);
    }
};

if (require.main === module) {
    runComponent(spec).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = { ...spec, runInviteFlow };

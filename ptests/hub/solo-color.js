const { openHubLobby, launchDesktopBrowser, assertSoloOpponentColorIsAiInvert, runComponent } = require('./shared');

const spec = {
    id: 'solo-color',
    name: 'Solo lobby opponent color (inverted theme)',
    async run(browser) {
        const { context, page } = await launchDesktopBrowser(browser);
        try {
            await openHubLobby(page, 'HubSoloColorTest');
            await assertSoloOpponentColorIsAiInvert(page);
        } finally {
            await context.close().catch(() => {});
        }
    }
};

if (require.main === module) {
    runComponent(spec).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = spec;

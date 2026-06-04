const { openHubLobby, launchDesktopBrowser, runComponent } = require('./shared');

const spec = {
    id: 'desktop-shell',
    name: 'Desktop hub shell (no mobile chrome)',
    async run(browser) {
        const { context, page } = await launchDesktopBrowser(browser);
        try {
            await openHubLobby(page, 'HubDesktopShellTest');
            const desktop = await page.evaluate(() => ({
                fiveMobile: document.documentElement.classList.contains('five-mobile'),
                barDisplay: getComputedStyle(document.getElementById('mobile-bar')).display,
                triggerVisible: (() => {
                    const t = document.getElementById('settings-trigger');
                    return t && getComputedStyle(t).display !== 'none';
                })()
            }));
            if (desktop.fiveMobile) {
                throw new Error(`Expected desktop hub (no five-mobile): ${JSON.stringify(desktop)}`);
            }
            if (desktop.barDisplay !== 'none') {
                throw new Error(`Mobile bar should be hidden on desktop (got ${desktop.barDisplay})`);
            }
            if (!desktop.triggerVisible) {
                throw new Error('Desktop #settings-trigger should be visible');
            }
        } finally {
            await context.close().catch(() => {});
        }
    }
};

if (require.main === module) {
    runComponent(spec).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = spec;

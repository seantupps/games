const { openHubLobby, launchDesktopBrowser, runComponent, HUB_MS } = require('./shared');

const spec = {
    id: 'settings-toggle',
    name: 'Settings sidebar toggle (S key)',
    async run(browser) {
        const { context, page } = await launchDesktopBrowser(browser);
        try {
            await openHubLobby(page, 'HubSettingsTest');
            await page.locator('body').click({ position: { x: 400, y: 400 }, timeout: HUB_MS });
            await page.keyboard.press('s');
            await page.waitForFunction(() => {
                const sb = document.getElementById('settings-sidebar');
                if (!sb?.classList.contains('open')) return false;
                const r = sb.getBoundingClientRect();
                const vw = window.innerWidth;
                return r.width > 40 && r.right >= vw - 8 && r.left > vw * 0.4;
            }, { timeout: HUB_MS });

            await page.keyboard.press('s');
            await page.waitForFunction(
                () => !document.getElementById('settings-sidebar')?.classList.contains('open'),
                { timeout: HUB_MS }
            );
        } finally {
            await context.close().catch(() => {});
        }
    }
};

if (require.main === module) {
    runComponent(spec).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = spec;

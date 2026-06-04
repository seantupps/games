const { chromium } = require('playwright');

(async () => {
    console.log('🚀 Starting Background Interaction Audit...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Target URL: http://127.0.0.1:8000/shared/index.html
    const url = 'http://127.0.0.1:8000/shared/index.html';

    page.on('console', msg => console.log(`[BROWSER] ${msg.text()}`));

    async function checkBackgroundClick(gameName) {
        console.log(`\n🎮 Testing ${gameName.toUpperCase()}...`);

        // Check if settings is already open, if not, open it
        let isOpen = await page.$eval('#settings-sidebar', el => el.classList.contains('open'));
        if (!isOpen) {
            console.log(`⌨️  Opening settings for ${gameName}...`);
            await page.click('#settings-trigger');
            await page.waitForTimeout(1000);
        }

        isOpen = await page.$eval('#settings-sidebar', el => el.classList.contains('open'));
        if (isOpen) console.log(`✅ ${gameName}: Settings is OPEN.`);
        else throw new Error(`❌ ${gameName}: Settings failed to open.`);

        // 2. Click the background
        console.log(`抽  Clicking background in ${gameName} frame...`);

        const frameElement = await page.waitForSelector('#game-frame');
        const frame = await frameElement.contentFrame();

        // Wait for game area to be ready
        await frame.waitForSelector('#game-container');

        // Click specifically on the game container in the iframe
        // Using a 10,10 offset inside the container to hit empty space
        await frame.click('#game-container', { position: { x: 10, y: 10 } });
        await page.waitForTimeout(1500);

        let isClosed = await page.$eval('#settings-sidebar', el => !el.classList.contains('open'));
        if (isClosed) console.log(`✅ ${gameName}: Settings closed on background click.`);
        else {
            console.warn(`❌ ${gameName}: Settings STAYED OPEN on background click.`);
        }

        return isClosed;
    }

    try {
        await page.goto(url, { waitUntil: 'networkidle' });

        // SWITCH TO LINE IMMEDIATELY
        console.log('🔄 Switching to LINE...');
        await page.click('#settings-trigger'); // Ensure menu is open to switch
        await page.waitForSelector('#btn-line');
        await page.click('#btn-line');
        await page.waitForTimeout(2000); // Wait for frame to reload

        await checkBackgroundClick('line');

        // And check Piles too just to be sure
        console.log('\n🔄 Switching back to PILES...');
        await page.click('#settings-trigger');
        await page.waitForSelector('#btn-piles');
        await page.click('#btn-piles');
        await page.waitForTimeout(2000);

        await checkBackgroundClick('piles');

    } catch (err) {
        console.error('💥 Audit Failed:', err.message);
    } finally {
        await page.waitForTimeout(2000);
        await browser.close();
        console.log('\n🏁 Audit completed.');
    }
})();

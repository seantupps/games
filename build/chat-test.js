const { chromium } = require('playwright');

(async () => {
    console.log('🚀 Starting Chat Rendering Audit...');
    const browser = await chromium.launch({ headless: false }); // Set to true if you don't want to see it
    const context = await browser.newContext();
    const page = await context.newPage();

    const url = 'http://127.0.0.1:8000/shared/index.html';

    page.on('console', msg => console.log(`[BROWSER] ${msg.text()}`));

    try {
        await page.goto(url, { waitUntil: 'networkidle' });

        console.log('⌨️  Opening chat with T...');
        await page.keyboard.press('t');
        await page.waitForTimeout(500);

        const isInputVisible = await page.isVisible('#chat-input');
        if (isInputVisible) {
            console.log('✅ Chat input is visible.');
        } else {
            console.error('❌ Chat input is HIDDEN after pressing T.');
        }

        const directTest = `DirectTest_${Math.random().toString(36).substring(7)}`;
        console.log(`💉 Injecting direct message: ${directTest}`);
        await page.evaluate((text) => ChatEngine.append({ sender: 'TestUser', content: text }), directTest);
        await page.waitForTimeout(1000);

        // Verify if the message is in the DOM
        const messages = await page.$$eval('.chat-msg .content', els => els.map(e => e.textContent));
        console.log('📋 Current messages on screen:', messages);

        if (messages.includes(directTest)) {
            console.log('✅ Success: Direct message found in DOM.');

            // Check visibility style of the actual element
            const visibility = await page.$eval('.chat-msg:last-child', el => {
                const s = window.getComputedStyle(el);
                return { opacity: s.opacity, visibility: s.visibility };
            });
            console.log('👀 Message visibility:', visibility);
        } else {
            console.error('❌ Failure: Direct message NOT found in DOM.');
        }


    } catch (err) {
        console.error('💥 Audit Failed:', err.message);
    } finally {
        console.log('\n🏁 Audit completed. Waiting 5s for manual inspection...');
        await page.waitForTimeout(5000);
        await browser.close();
    }
})();

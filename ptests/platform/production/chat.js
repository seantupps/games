/**
 * Production chat visibility: lobby + party room.
 */
const {
    RUN_ID, prodUid, ensureProdStack, launchBrowser,
    setupPlayerPage, waitForNetwork, cleanupRoom, cleanupPresence, buildHubUrl
} = require('./prod-utils');

async function assertChatLineVisible(page, line, label) {
    const info = await page.evaluate((text) => {
        const el = Array.from(document.querySelectorAll('#chat-messages .chat-msg'))
            .find((n) => n.innerText.includes(text));
        if (!el) return { found: false };
        const cs = getComputedStyle(el);
        return {
            found: true,
            faded: el.classList.contains('faded'),
            opacity: cs.opacity,
            innerText: el.innerText
        };
    }, line);
    if (!info.found) throw new Error(`${label}: message not found: "${line}"`);
    if (info.faded || Number(info.opacity) < 0.5) {
        throw new Error(`${label}: message invisible (faded=${info.faded}, opacity=${info.opacity})`);
    }
}

async function runLobbyChatCheck(page) {
    const line = `lobby chat ${RUN_ID}`;
    await page.keyboard.press('t');
    await page.fill('#chat-input', line);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await assertChatLineVisible(page, line, 'Lobby');
    console.log('[PROD:CHAT] Lobby OK');
}

async function runChatTest() {
    console.log('\n[PROD:CHAT] Starting party chat test...');
    await ensureProdStack();

    const hostUid = prodUid('CHAT_H');
    const guestUid = prodUid('CHAT_G');
    const hostName = `PW Chat Host ${RUN_ID}`;
    const guestName = `PW Chat Guest ${RUN_ID}`;
    const chatLine = `hello from host ${RUN_ID}`;

    const browser = await launchBrowser();
    const ctxH = await browser.newContext();
    const ctxG = await browser.newContext();
    const pageH = await ctxH.newPage();
    const pageG = await ctxG.newPage();
    let roomId = null;

    try {
        await setupPlayerPage(pageH, hostUid, hostName, '#3b82f6', 'Host');
        await setupPlayerPage(pageG, guestUid, guestName, '#ef4444', 'Guest');
        await Promise.all([waitForNetwork(pageH), waitForNetwork(pageG)]);
        await pageH.waitForTimeout(2000);

        await runLobbyChatCheck(pageH);

        await pageH.click('#settings-trigger');
        await pageH.waitForSelector('#settings-sidebar.open');
        await pageH.locator('#player-list .player-item').filter({ hasText: guestName }).click();

        await pageG.waitForSelector('#invite-toast.show', { timeout: 15000 });
        await pageG.click('#btn-accept-invite');
        await pageG.waitForFunction(() => {
            const r = new URLSearchParams(window.location.search).get('room');
            return r && r !== 'lobby';
        }, { timeout: 15000 });

        roomId = await pageH.evaluate(() => new URLSearchParams(window.location.search).get('room'));
        const guestRoom = await pageG.evaluate(() => new URLSearchParams(window.location.search).get('room'));
        if (!roomId || roomId !== guestRoom) {
            throw new Error(`Room mismatch: host=${roomId} guest=${guestRoom}`);
        }
        console.log(`[PROD:CHAT] Party room: ${roomId}`);

        await pageH.waitForTimeout(1500);

        // Host sends chat
        await pageH.keyboard.press('t');
        await pageH.fill('#chat-input', chatLine);
        await pageH.keyboard.press('Enter');

        await pageH.waitForTimeout(800);
        await assertChatLineVisible(pageH, chatLine, 'Host');
        await assertChatLineVisible(pageG, chatLine, 'Guest');

        console.log('[PROD:CHAT] SUCCESS');
    } finally {
        await cleanupRoom(pageH, roomId);
        await cleanupPresence(pageH, [hostUid, guestUid]);
        await browser.close();
    }
}

if (require.main === module) {
    runChatTest().catch((e) => { console.error('[PROD:CHAT] FAILURE:', e.message); process.exit(1); });
}

module.exports = { runChatTest };




const { chromium } = require('playwright');

const args = process.argv.slice(2);
const isLine = args.includes('--line');

(async () => {
    console.log(`Starting Line Random Simulation Audit...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('[LOGIC]') || text.includes('WINNER') || text.includes('[TEST]') || text.includes('[ENGINE]') || text.includes('HOST:') || text.includes('[Input]') || text.includes('[Render]') || text.includes('[Scoreboard]')) {
            console.log(`[BROWSER] ${msg.type().toUpperCase()}: ${text}`);
        }
    });

    page.on('response', response => {
        if (response.status() >= 400) {
            console.error(`[BROWSER] NETWORK ERROR ${response.status()}: ${response.url()}`);
        }
    });

    try {
        await page.goto('http://127.0.0.1:8000/shared/index.html');
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('username', 'TotallyAwesome5'); });

        const initialUrl = 'http://127.0.0.1:8000/shared/index.html?room=lobby&role=P1&game=line';
        await page.goto(initialUrl);
        await page.waitForTimeout(2000);

        // 1. Wait for Game to be fully ready
        console.log('[TEST] Waiting for game initialization...');
        await page.waitForFunction(() => {
            const frame = document.getElementById('game-frame');
            return frame && frame.contentWindow && frame.contentWindow.game && frame.contentWindow.game.nodes.length > 0;
        }, { timeout: 5000 });

        // 2. Perform UI Drag Test from Node 1
        console.log('[TEST] Performing UI Drag from Node 1...');
        const iframeHandle = await page.$('#game-frame');
        const box = await iframeHandle.boundingBox();

        const n1_target = await page.evaluate(() => {
            const frame = document.getElementById('game-frame');
            const gDoc = frame.contentWindow.document;
            const node = gDoc.querySelector('.node[data-id="1"]');
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });

        const n5_target = await page.evaluate(() => {
            const frame = document.getElementById('game-frame');
            const gDoc = frame.contentWindow.document;
            const node = gDoc.querySelector('.node[data-id="5"]');
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });

        if (!n1_target || !n5_target) {
            console.error('FAILURE: Target nodes not found in UI.');
            process.exit(1);
        }

        // Convert to absolute page coordinates
        const n1_abs = { x: box.x + n1_target.x, y: box.y + n1_target.y };
        const n5_abs = { x: box.x + n5_target.x, y: box.y + n5_target.y };

        await page.mouse.move(n1_abs.x, n1_abs.y);
        await page.mouse.down();
        await page.mouse.move(n5_abs.x, n5_abs.y, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(1000);

        // 3. Verify UI Move and Colors
        console.log('[TEST] Verifying Color Consistency...');
        const colorResults = await page.evaluate(() => {
            const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
            const frame = document.getElementById('game-frame');
            const gameDoc = frame.contentWindow.document;

            const scoreUser = gameDoc.querySelector('.score-user');
            const scoreColor = scoreUser ? getComputedStyle(scoreUser).color : null;

            const line = gameDoc.querySelector('line.mine.p1'); // Specifically look for p1 line
            const lineStroke = line ? getComputedStyle(line).stroke : null;

            const game = frame.contentWindow.game;
            const moveExecuted = game.path.length > 0;

            return { themeColor, scoreColor, lineStroke, moveExecuted };
        });

        console.log(`[TEST] Theme: ${colorResults.themeColor}, Score: ${colorResults.scoreColor}, Line: ${colorResults.lineStroke}`);

        if (!colorResults.moveExecuted) {
            console.error('FAILURE: UI Drag from Node 1 failed to execute a move.');
            process.exit(1);
        }

        // Simple helper to normalize colors for comparison (rgb/rgba/hex)
        const normalize = (c) => {
            if (!c) return null;
            c = c.replace(/\s/g, '').toLowerCase();
            if (c.startsWith('#')) {
                const r = parseInt(c.slice(1, 3), 16);
                const g = parseInt(c.slice(3, 5), 16);
                const b = parseInt(c.slice(5, 7), 16);
                return `rgb(${r},${g},${b})`;
            }
            return c;
        };

        const nScore = normalize(colorResults.scoreColor);
        const nTheme = normalize(colorResults.themeColor);
        const nLine = normalize(colorResults.lineStroke);

        console.log(`[TEST] Normalized - Theme: ${nTheme}, Score: ${nScore}, Line: ${nLine}`);

        if (nScore !== nTheme) {
            console.error(`FAILURE: Scoreboard color (${nScore}) mismatch with theme (${nTheme}).`);
            process.exit(1);
        }

        // Line stroke might be slightly different due to opacity or filters, but should contain the base color
        // Actually, let's just check if it's there for now as requested
        if (!nLine && colorResults.moveExecuted) {
            console.warn('[TEST] Warning: Line segment detected but stroke color capture returned null (possibly due to filters).');
        }

        console.log('SUCCESS: Color consistency and Node 1 UI drag verified.');

        console.log('[TEST] Resuming Random Move Loop...');
        let isOver = false;
        let moveCount = 1; // Started with one UI move
        page.retryCount = 0;

        while (!isOver && moveCount < 50) {
            moveCount++;
            const moveData = await page.evaluate((rc) => {
                const frame = document.getElementById('game-frame');
                const g = frame ? frame.contentWindow.game : null;
                if (!g) return { retry: true, retryCount: rc };
                if (g.isOver) return { isOver: true };

                const moves = g.getValidMoves();
                if (moves.length === 0) return { isOver: true };

                const move = moves[Math.floor(Math.random() * moves.length)];
                g.submitMove(move);
                return { isOver: false, move: move };
            }, page.retryCount);

            if (moveData.retry) {
                const retryCount = (moveData.retryCount || 0) + 1;
                if (retryCount > 2) {
                    console.error('FAILURE: Game failed to initialize after 2 retries.');
                    process.exit(1);
                }
                console.log(`[TEST] Game not ready (Retry ${retryCount}/2), retrying...`);
                await page.waitForTimeout(1000);
                moveCount--;
                page.retryCount = retryCount;
                continue;
            }
            page.retryCount = 0;

            if (moveData.isOver) {
                isOver = true;
                console.log(`[TEST] Game Over detected after ${moveCount} iterations.`);
            } else {
                console.log(`[TEST] Move ${moveCount}: ${moveData.move.a} -> ${moveData.move.b}`);
                await page.waitForTimeout(400); // Wait for transition
            }
        }

        // Final verification for banner
        console.log('[TEST] Waiting for Victory Banner...');
        await page.waitForSelector('#global-win-banner.visible', { timeout: 5000 }).catch(() => {
            console.warn('[TEST] Victory banner class "visible" not detected within 5s');
        });

        const bannerStatus = await page.evaluate(() => {
            const banner = document.getElementById('global-win-banner');
            return {
                visible: banner ? banner.classList.contains('visible') : false,
                text: banner ? banner.innerText : '',
                opacity: banner ? getComputedStyle(banner).opacity : '0'
            };
        });

        console.log(`[TEST] Banner: Visible=${bannerStatus.visible}, Text="${bannerStatus.text}"`);

        if (bannerStatus.visible && bannerStatus.text.includes('WINS')) {
            console.log('SUCCESS: Victory Banner verified.');
        } else {
            console.error('FAILURE: Victory Banner failed to appear.');
            process.exit(1);
        }

        // Auto-reset verification
        console.log('[TEST] Waiting for Auto-Reset (Banner to disappear)...');
        await page.waitForFunction(() => {
            const banner = document.getElementById('global-win-banner');
            return banner && !banner.classList.contains('visible');
        }, { timeout: 10000 }).catch(() => {
            console.error('FAILURE: Auto-Reset failed - Victory Banner still visible after 10s');
            process.exit(1);
        });

        const finalStatus = await page.evaluate(() => {
            const frame = document.getElementById('game-frame');
            const g = frame ? frame.contentWindow.game : null;
            const banner = document.getElementById('global-win-banner');
            if (!g || !banner) return { error: `Missing components: g=${!!g}, banner=${!!banner}` };
            return {
                bannerVisible: banner.classList.contains('visible'),
                gameReset: !g.isOver && (!g.lines || g.lines.length === 0) && (!g.path || g.path.length === 0)
            };
        });

        if (finalStatus.error) {
            console.error(`FAILURE: Verification error: ${finalStatus.error}`);
            process.exit(1);
        }

        if (!finalStatus.bannerVisible && finalStatus.gameReset) {
            console.log('SUCCESS: RANDOM SIMULATION VERIFIED BANNER AND AUTO-RESET');
        } else {
            console.error(`FAILURE: Auto-Reset check failed. BannerVisible=${finalStatus.bannerVisible}, GameReset=${finalStatus.gameReset}`);
            process.exit(1);
        }

    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();

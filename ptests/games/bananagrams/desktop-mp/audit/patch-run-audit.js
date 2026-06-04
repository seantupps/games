#!/usr/bin/env node
/**
 * Patch run-audit.js: replace hardcoded dump/peel blocks with AI playthrough.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'run-audit.js');
let src = fs.readFileSync(file, 'utf8');

function removeBetween(startNeedle, endNeedle, label) {
    const i0 = src.indexOf(startNeedle);
    const i1 = src.indexOf(endNeedle, i0 === -1 ? 0 : i0);
    if (i0 === -1 || i1 === -1) {
        console.error(`[patch] FAILED ${label}: start=${i0} end=${i1}`);
        process.exit(1);
    }
    src = src.slice(0, i0) + src.slice(i1);
    console.log(`[patch] Removed ${label} (${i1 - i0} chars)`);
}

// Hardcoded 4x dump block (after no-peel-on-rack)
removeBetween(
    "    await syncGuestInventoryToHost(page1, page2, GUEST_UID);\n\n    log(mobile ? 'DUMP (hold): host dumps 1 tile, draws 3...'",
    "    log('Invalid grid",
    'hardcoded dump block'
);

// Peel fixtures + alternating peel series (after disconnected-tile test)
const aiInsert = `    log('AI: solver-driven host + guest playthrough (placement, peel, dump)...');
    const { runMpAiPlaythrough } = require('./mp-ai-playthrough');
    await runMpAiPlaythrough({
        page1,
        page2,
        frame1,
        frame2,
        mp,
        mobile,
        assertBoardStatesHealthy
    });
    log('SUCCESS: AI playthrough complete.');

    `;

const peelStart = "    await syncGuestInventoryToHost(page1, page2, GUEST_UID);\n\n    await Promise.all([frame1, frame2].map((f) => f.evaluate(() => {\n        const g = window.game;\n        if (!g?._checker || g._checker._threeLetterPatched) return false;";
const peelEnd = "    log('Post-game review:";
const iPeel0 = src.indexOf(peelStart);
const iPeel1 = src.indexOf(peelEnd, iPeel0);
if (iPeel0 === -1 || iPeel1 === -1) {
    console.error(`[patch] FAILED peel block: start=${iPeel0} end=${iPeel1}`);
    process.exit(1);
}
src = src.slice(0, iPeel0) + aiInsert + src.slice(iPeel1);
console.log(`[patch] Replaced peel fixture block with AI playthrough (${iPeel1 - iPeel0} chars removed)`);

fs.writeFileSync(file, src, 'utf8');
console.log('[patch] Done:', file);

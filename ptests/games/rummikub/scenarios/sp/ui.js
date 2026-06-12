/**
 * Rummikub solo UI audit — tiles, colors, drag, pan/zoom (desktop + mobile).
 * No seeded puzzles: asserts hold for any valid random generation.
 */
const { STEP_MS } = require('../../../../shared/infra/timeouts');
const { panBackgroundInFrame, dragTileInFrame } = require('../../../../shared/adapters/pan-zoom-touch');
const { assertWheelZoomViewportCentered } = require('../../../../shared/assertions/viewport');
const {
    assertPanZoomTilesFitViewport,
    assertPanZoomBoardCentered
} = require('../../../../shared/assertions/pan-zoom-board');
const { assertPinchZoomRange } = require('../../../../platform/mobile/lib/mobile_assertions');
const { waitForRummikubReady } = require('../../lib/session');
const {
    assertAllTilesVisible,
    assertRectangularTiles,
    assertTileDigitColors,
    assertTableAndRack,
    assertRackBelowCenter,
    assertBoardCenteredHorizontally,
    assertRackCenteredHorizontally,
    assertRackMaxThreeRows
} = require('../../assertions/tiles');
const {
    assertTileFaceThemeColor,
    assertNoOverlappingTiles,
    assertTableTilesGridAligned,
    assertAdjacentTileSnap,
    assertStackingDropNoOverlap,
    assertLeftSnapIgnoresRack,
    assertSelectionHitExpand,
    assertCornerDropNoOverlap,
    assertAutoInsert,
    assertTableMeldsDisconnected,
    assertIsolatedDropExactPosition,
    assertGroupDragCohesion,
    assertSingleTileHorizontalSnap,
    assertGroupHorizontalSnap,
    assertTapSelectsConnectedSubMeld,
    assertMobileFluidBackgroundPan,
    assertMobileTapClearsSelection,
    assertMobileMarqueeBlocksPan,
    assertMobileMarqueeSelection,
    assertMobileMarqueeAfterPan,
    assertMobilePinchSkipsMarquee
} = require('../../assertions/layout');

function log(msg) {
    console.log(`[TEST] ${msg}`);
}

/**
 * @param {import('playwright').Page} page
 * @param {{ isMobile?: boolean }} [ctx]
 */
async function runSpUiAudit(page, ctx = {}) {
    const isMobile = !!ctx.isMobile;
    const pointerType = isMobile ? 'touch' : 'mouse';
    log(`Rummikub solo UI audit (${isMobile ? 'mobile' : 'desktop'})...`);

    await waitForRummikubReady(page);

    log('Starting board fits viewport (shared pan-zoom assertion)...');
    await assertPanZoomTilesFitViewport(page, {
        minTiles: 54,
        margin: isMobile ? 12 : 8,
        isMobile
    });
    log('SUCCESS: All tiles inside viewport.');

    log('Board content centered on load...');
    await assertPanZoomBoardCentered(page, { maxDriftPx: isMobile ? 140 : 120 });
    log('SUCCESS: Board centered.');

    const gameFrame = await waitForRummikubReady(page);

    log('All tiles visible with digit labels...');
    await assertAllTilesVisible(gameFrame);
    log('SUCCESS: Tiles visible.');

    log('Table melds + rack present (step-3 style start)...');
    await assertTableAndRack(gameFrame);
    log('SUCCESS: Board and rack populated.');

    log('Table melds spawn disconnected (separate islands)...');
    await assertTableMeldsDisconnected(gameFrame);
    log('SUCCESS: Disconnected table melds.');

    log('Board melds centered horizontally on screen...');
    await assertBoardCenteredHorizontally(gameFrame);
    log('SUCCESS: Board horizontally centered.');

    log('Rack uses at most 3 rows...');
    await assertRackMaxThreeRows(gameFrame);
    log('SUCCESS: Rack capped at 3 rows.');

    log('Rack centered horizontally on screen...');
    await assertRackCenteredHorizontally(gameFrame);
    log('SUCCESS: Rack horizontally centered.');

    log('Tiles are rectangular (taller than wide)...');
    await assertRectangularTiles(gameFrame);
    log('SUCCESS: Rectangular tiles.');

    log('Tile face background uses player theme color...');
    await assertTileFaceThemeColor(gameFrame);
    log('SUCCESS: Theme tile faces.');

    log('Digit colors match Rummikub palette (B/R/U/O)...');
    await assertTileDigitColors(gameFrame);
    log('SUCCESS: Tile digit colors correct.');

    log('No overlapping tiles at deal...');
    await assertNoOverlappingTiles(gameFrame);
    log('SUCCESS: No overlaps.');

    log('Table tiles aligned to grid cells...');
    await assertTableTilesGridAligned(gameFrame);
    log('SUCCESS: Grid-aligned table tiles.');

    log(`Selection hit expand (${isMobile ? 'mobile on' : 'desktop off'})...`);
    await assertSelectionHitExpand(gameFrame, isMobile);
    log('SUCCESS: Hit expand policy.');

    log('Group drag keeps formation when isolated...');
    await assertGroupDragCohesion(gameFrame);
    log('SUCCESS: Group cohesion (no grid snap).');

    log('Group drag snaps right of external tile...');
    const snapRight = await assertGroupHorizontalSnap(
        gameFrame, 'right', 'group-snap-right', { warnOnly: isMobile }
    );
    if (snapRight?.warn) {
        log(`WARN: group-snap-right skipped (${JSON.stringify(snapRight.result)})`);
    } else {
        log('SUCCESS: Group right snap.');
    }

    log('Group drag snaps left of external tile...');
    const snapLeft = await assertGroupHorizontalSnap(
        gameFrame, 'left', 'group-snap-left', { warnOnly: isMobile }
    );
    if (snapLeft?.warn) {
        log(`WARN: group-snap-left skipped (${JSON.stringify(snapLeft.result)})`);
    } else {
        log('SUCCESS: Group left snap.');
    }

    log('Adjacent tile snap (no stacking)...');
    await assertAdjacentTileSnap(gameFrame);
    log('SUCCESS: Edge snap.');

    log('Single tile snaps right of neighbor...');
    await assertSingleTileHorizontalSnap(gameFrame, 'right', 'single-snap-right');
    log('SUCCESS: Single tile right snap.');

    log('Single tile snaps left of neighbor...');
    await assertSingleTileHorizontalSnap(gameFrame, 'left', 'single-snap-left');
    log('SUCCESS: Single tile left snap.');

    log('Stacking drop resolves without overlap...');
    await assertStackingDropNoOverlap(gameFrame);
    log('SUCCESS: No stack overlap.');

    log('Left snap ignores rack decoys...');
    await assertLeftSnapIgnoresRack(gameFrame);
    log('SUCCESS: Table-only snap.');

    log('Isolated drop keeps exact landing position (no grid snap)...');
    await assertIsolatedDropExactPosition(gameFrame);
    log('SUCCESS: Isolated drop exact.');

    log('Corner drop does not overlap neighbors...');
    await assertCornerDropNoOverlap(gameFrame);
    log('SUCCESS: Corner drop resolved without overlap.');

    log('Auto-insert fills one-tile gap (enabled)...');
    await assertAutoInsert(gameFrame, true);
    log('SUCCESS: Auto-insert on.');

    log('Auto-insert skipped when disabled...');
    await assertAutoInsert(gameFrame, false);
    log('SUCCESS: Auto-insert off.');

    log('Rack dealt below viewport center...');
    await assertRackBelowCenter(gameFrame);
    log('SUCCESS: Rack below center.');

    log('Background pan moves board...');
    if (isMobile) {
        log('SKIP: Mobile background pan covered by fluid-drag pan test below.');
    } else {
        const pan = await panBackgroundInFrame(gameFrame, { pointerType });
        if (!pan.viewportPanEnabled) {
            throw new Error(`viewportPanEnabled expected (${JSON.stringify(pan)})`);
        }
        if (!pan.panInit) {
            throw new Error(`Viewport pan handlers not attached (${JSON.stringify(pan)})`);
        }
        if (!pan.ok) {
            throw new Error(`Background pan should move board (${JSON.stringify(pan)})`);
        }
        log(`SUCCESS: Background pan (${Math.round(pan.dist)}px).`);
    }

    log('Tile drag moves piece on board...');
    const rackIdx = await gameFrame.evaluate(() => {
        const g = window.game;
        const rackId = (g?.tiles || []).find((t) => t.zone === 'rack')?.id;
        if (!rackId) return -1;
        const nodes = [...document.querySelectorAll('.tile')];
        return nodes.findIndex((n) => n.dataset.tileId === rackId);
    });
    if (rackIdx < 0) throw new Error('No rack tile found for drag test');

    const drag = await dragTileInFrame(gameFrame, {
        tileIndex: rackIdx,
        dx: isMobile ? 40 : 48,
        dy: isMobile ? -140 : -160,
        pointerType
    });
    if (!drag.ok || !drag.moved) {
        throw new Error(`Tile drag failed (${JSON.stringify(drag)})`);
    }
    log('SUCCESS: Tile draggable.');

    log('No overlapping tiles after drag...');
    await assertNoOverlappingTiles(gameFrame, 'no-overlap-after-drag');
    log('SUCCESS: Snap kept tiles separated.');

    if (isMobile) {
        log('Pinch zoom in/out...');
        await assertPinchZoomRange(page, ctx.mobileMs ?? STEP_MS);
        log('SUCCESS: Pinch zoom range.');
    } else {
        log('Wheel zoom keeps viewport center stable...');
        const zoom = await assertWheelZoomViewportCentered(page);
        if (zoom?.skip) {
            log('SKIP: Wheel zoom not ready.');
        } else {
            log('SUCCESS: Wheel zoom centered.');
        }
    }

    log('Tap selects one meld when two runs share an edge...');
    await assertTapSelectsConnectedSubMeld(gameFrame);
    log('SUCCESS: Sub-meld tap selection.');

    if (isMobile) {
        log('Tap empty board clears selection (surface + canvas)...');
        await assertMobileTapClearsSelection(gameFrame);
        log('SUCCESS: Background tap deselects.');

        log('Immediate background drag pans (no hold)...');
        await assertMobileFluidBackgroundPan(gameFrame);
        log('SUCCESS: Fluid drag pans.');

        log('Hold background + drag marquee selects tiles...');
        await assertMobileMarqueeSelection(gameFrame);
        log('SUCCESS: Mobile marquee selection.');

        log('Marquee works after quick pan swipe...');
        await assertMobileMarqueeAfterPan(gameFrame);
        log('SUCCESS: Marquee after pan.');

        log('Hold + drag does not pan board...');
        await assertMobileMarqueeBlocksPan(gameFrame);
        log('SUCCESS: Marquee blocks pan.');

        log('Pinch / second finger skips marquee...');
        await assertMobilePinchSkipsMarquee(gameFrame);
        log('SUCCESS: Pinch skips marquee.');
    }

    log(`Rummikub solo UI audit complete (${isMobile ? 'mobile' : 'desktop'}).`);
}

module.exports = { runSpUiAudit };

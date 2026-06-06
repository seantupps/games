/**
 * Host-authoritative MP micro-fixtures (4-tile symmetric state).
 * Synthetic layouts are OK; guest-only teleports and asymmetric owned counts are not.
 */
const { HOST_UID, GUEST_UID, WAIT_MS, waitForDiag } = require('./mp-lib');

const FIXTURE_Y0 = 2200;

/** 3-letter dictionary patch — peel micro-grids use CAT/ATT-style words. */
async function patchMpThreeLetterChecker(frames) {
    await Promise.all(frames.map((f) => f.evaluate(() => {
        const g = window.game;
        if (!g?._checker || g._checker._threeLetterPatched) return false;
        const base = g._checker;
        g._checker = {
            _threeLetterPatched: true,
            isPrefix(str) {
                const s = String(str || '').toLowerCase();
                if (/^[a-z]+$/.test(s) && s.length <= 3) return true;
                return base.isPrefix(s);
            },
            isWord(str) {
                const s = String(str || '').toLowerCase();
                if (/^[a-z]{2,3}$/.test(s)) return true;
                return base.isWord(s);
            }
        };
        return true;
    })));
}

/**
 * Host writes symmetric 4-tile owned + layouts for both players, then syncs board.
 * @param {import('playwright').Frame} frame1
 * @param {import('playwright').Page} page2
 * @param {object} mp
 * @param {{ hostUid?: string, guestUid?: string, guestLayout: 'stragglers'|'peel' }} opts
 */
async function installSymmetricFourTileFixture(frame1, page2, mp, opts) {
    const {
        hostUid = HOST_UID,
        guestUid = GUEST_UID,
        guestLayout = 'peel',
        source = 'mp-micro-fixture'
    } = opts;

    const setup = await frame1.evaluate(({ hostUid: hUid, guestUid: gUid, guestLayout: gLayout, src, y0 }) => {
        const g = window.game;
        if (!g?.isHost?.()) return { ok: false, reason: 'not-host' };

        const patchLetters = (ids, letters) => {
            g._mpEnsureCanonicalMap?.();
            if (!g._mpCanonicalById) g._mpCanonicalById = {};
            ids.forEach((id, i) => {
                g._mpCanonicalById[id] = letters[i];
            });
        };

        const buildCatPeelGridTiles = (ids, originX) => {
            const gap = window.BananaRules.TILE_GAP;
            const letters = ['C', 'A', 'T', 'T'];
            patchLetters(ids, letters);
            return [
                { id: ids[0], letter: 'C', x: originX, y: y0, faceUp: true },
                { id: ids[1], letter: 'A', x: originX, y: y0 + gap, faceUp: true },
                { id: ids[2], letter: 'T', x: originX, y: y0 + gap * 2, faceUp: true },
                { id: ids[3], letter: 'T', x: originX + gap, y: y0 + gap, faceUp: true }
            ];
        };

        const buildGuestStragglerGridTiles = (ids, originX) => {
            const gap = window.BananaRules.TILE_GAP;
            const letters = ['C', 'A', 'X', 'Y'];
            patchLetters(ids, letters);
            return [
                { id: ids[0], letter: 'C', x: originX, y: y0, faceUp: true },
                { id: ids[1], letter: 'A', x: originX, y: y0 + gap, faceUp: true },
                { id: ids[2], letter: 'X', x: originX + gap * 10, y: y0, faceUp: true },
                { id: ids[3], letter: 'Y', x: originX + gap * 10, y: y0 + gap * 3, faceUp: true }
            ];
        };

        const hostOwned = [...(g._mpOwned?.[hUid] || [])];
        const guestOwned = [...(g._mpOwned?.[gUid] || [])];
        if (hostOwned.length < 4 || guestOwned.length < 4) {
            return {
                ok: false,
                reason: 'short-owned',
                host: hostOwned.length,
                guest: guestOwned.length
            };
        }

        const hostIds = hostOwned.slice(0, 4).map((t) => t.id);
        const guestIds = guestOwned.slice(0, 4).map((t) => t.id);
        const guestOriginX = gLayout === 'stragglers' ? g.ORIGIN + 600 : g.ORIGIN;
        const hostTiles = buildCatPeelGridTiles(hostIds, g.ORIGIN);
        const guestTiles = gLayout === 'stragglers'
            ? buildGuestStragglerGridTiles(guestIds, guestOriginX)
            : buildCatPeelGridTiles(guestIds, guestOriginX);

        if (typeof g._hostSetPlayerTiles === 'function') {
            g._hostSetPlayerTiles(gUid, guestTiles, true, {
                allowTilesToOwned: true,
                source: `${src}:guest`
            });
            g._hostSetPlayerTiles(hUid, hostTiles, true, {
                allowTilesToOwned: true,
                source: `${src}:host`
            });
        } else {
            return { ok: false, reason: 'no-host-set-player-tiles' };
        }

        g._hostSyncBoard?.({ immediate: true });

        if (gLayout === 'stragglers') {
            const guestRuntime = guestTiles.map((t) => ({
                id: t.id,
                letter: t.letter,
                x: t.x,
                y: t.y,
                faceUp: t.faceUp
            }));
            if (typeof BananaGrid !== 'undefined' && BananaGrid.isConnected(guestRuntime)) {
                return { ok: false, reason: 'guest-stragglers-still-connected' };
            }
        }

        return {
            ok: true,
            hostIds,
            guestIds,
            disconnectedIds: gLayout === 'stragglers' ? [guestIds[2], guestIds[3]] : []
        };
    }, {
        hostUid,
        guestUid,
        guestLayout,
        src: source,
        y0: FIXTURE_Y0
    });

    if (!setup.ok) {
        throw new Error(`installSymmetricFourTileFixture failed (${JSON.stringify(setup)})`);
    }

    await waitForDiag(page2, 'micro fixture guest projected', () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return (g?.tiles?.length ?? 0) === 4;
    }, {}, WAIT_MS, mp);

    await waitForDiag(frame1.page(), 'micro fixture host projected', () => {
        const g = document.getElementById('game-frame')?.contentWindow?.game;
        return (g?.tiles?.length ?? 0) === 4;
    }, {}, WAIT_MS, mp);

    return setup;
}

module.exports = {
    FIXTURE_Y0,
    patchMpThreeLetterChecker,
    installSymmetricFourTileFixture
};

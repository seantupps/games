/** Structured win / verify logging — console + /state lines. */
const RummikubWinLog = (() => {
    /**
     * 0 = off, 1 = wins + failures only, 2 = every check (default).
     */
    function level() {
        try {
            const v = localStorage.getItem('rummikub_win_log');
            if (v === '0') return 0;
            if (v === '1') return 1;
        } catch (_) { /* ignore */ }
        return 2;
    }

    function tileBrief(tile) {
        if (!tile) return '?';
        if (tile.kind === 'joker') {
            const as = tile.as ? `${tile.as.color}${tile.as.value}` : tile.display || 'J';
            return `J:${as}`;
        }
        return `${tile.color || '?'}${tile.value ?? '?'}`;
    }

    function poolHistogram(pool) {
        const counts = {};
        (pool || []).forEach((t) => {
            const k = tileBrief(t);
            counts[k] = (counts[k] || 0) + 1;
        });
        return counts;
    }

    function histogramLine(pool) {
        const counts = poolHistogram(pool);
        const parts = Object.keys(counts).sort().map((k) => `${k}×${counts[k]}`);
        return parts.length ? parts.join(' ') : '(empty)';
    }

    function log(event, msg, data, { minLevel = 1 } = {}) {
        const lv = level();
        if (lv === 0) return;
        if (lv < minLevel && event !== 'fail' && event !== 'win') return;
        const tag = `[rummikub:win:${event}]`;
        if (data === undefined) {
            (event === 'win' ? console.info : console.warn)(`${tag} ${msg}`);
            return;
        }
        (event === 'win' || event === 'check' ? console.info : console.warn)(`${tag} ${msg}`, data);
    }

    function verifyLines(verify, tableCount) {
        if (!verify) return [];
        const lines = [
            `Verify (${verify.method || '?'}): ${verify.solved ? 'SOLVED' : 'NOT SOLVED'}`,
            `  ${verify.melded ?? '?'}/${tableCount} in valid melds`
                + `, ${verify.meldCount ?? 0} meld(s)`
                + `, ${verify.remaining ?? '?'} orphan(s)`
                + `, ${verify.elapsedMs ?? '?'}ms`
        ];
        if (verify.clusters != null) {
            lines.push(`  Touch clusters on table: ${verify.clusters}`);
        }
        if (verify.reason) lines.push(`  Reason: ${verify.reason}`);
        if (verify.meldLabels?.length) {
            verify.meldLabels.slice(0, 8).forEach((label) => lines.push(`  ✓ ${label}`));
            if (verify.meldLabels.length > 8) {
                lines.push(`  … +${verify.meldLabels.length - 8} more meld(s)`);
            }
        }
        if (verify.invalidClusters?.length) {
            verify.invalidClusters.forEach((c) => {
                lines.push(`  ✗ cluster ${c.index} (${c.reason}, ${c.size} tiles): ${c.tiles.join(' ')}`);
            });
        }
        if (verify.timedOut) lines.push('  Verifier timed out.');
        return lines;
    }

    function linesFromDiag(diag) {
        if (!diag) return ['No win diagnostic available.'];
        const lines = [
            `── win check (${diag.trigger || '?'}) ──`,
            `Tiles: ${diag.totalTiles} total — rack ${diag.rackCount}, table ${diag.tableCount}`,
            `Can mutate: ${diag.canMutate}, overlaps: ${diag.overlaps}`
        ];
        if (diag.blockedReason) lines.push(`Blocked: ${diag.blockedReason}`);
        if (diag.rackCount > 0 && diag.rackIds?.length) {
            lines.push(`Rack ids: ${diag.rackIds.slice(0, 12).join(', ')}${diag.rackIds.length > 12 ? '…' : ''}`);
        }
        if (diag.zoneMismatches?.length) {
            lines.push(`Zone mismatches (${diag.zoneMismatches.length}):`
                + ` ${diag.zoneMismatches.map((m) => `${m.tile}@${m.y} zone=${m.zone} visual=${m.visual}`).join('; ')}`);
        }
        if (diag.poolHistogram) {
            lines.push(`Table pool: ${histogramLine(diag.poolHistogram)}`);
        }
        lines.push(...verifyLines(diag.partition, diag.tableCount));
        lines.push(diag.wouldWin ? '→ Win ready.' : '→ Not a win yet.');
        return lines;
    }

    function logCheckStart(trigger, diag) {
        log('check', `start (${trigger})`, {
            rack: diag.rackCount,
            table: diag.tableCount,
            overlaps: diag.overlaps,
            zoneMismatches: diag.zoneMismatches?.length || 0
        }, { minLevel: 2 });
    }

    function logCheckEnd(diag) {
        if (diag.wouldWin) {
            log('win', `ready (${diag.trigger})`, {
                method: diag.partition?.method,
                melds: diag.partition?.meldCount,
                elapsedMs: diag.partition?.elapsedMs
            });
            return;
        }
        log('fail', `not ready (${diag.trigger}): ${diag.blockedReason || diag.partition?.reason || '?'}`, {
            melded: diag.partition?.melded,
            remaining: diag.partition?.remaining,
            method: diag.partition?.method,
            timedOut: diag.partition?.timedOut,
            orphans: diag.partition?.orphanTiles
        });
    }

    return {
        level,
        tileBrief,
        poolHistogram,
        histogramLine,
        log,
        linesFromDiag,
        verifyLines,
        logCheckStart,
        logCheckEnd
    };
})();

if (typeof window !== 'undefined') {
    window.RummikubWinLog = RummikubWinLog;
}

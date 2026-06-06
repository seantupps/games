#!/usr/bin/env node
/**
 * Scaffold a new game from games/_template and ptests/games/_template.
 *
 * Usage:
 *   npm run new-game -- mygame "My Game"
 *   npm run new-game -- mygame "My Game" --sync=hybrid --mp
 *   npm run new-game -- mygame "My Game" --sync=board-authoritative --mp --policy=pan-zoom-board
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GAME_TEMPLATE = path.join(ROOT, 'games', '_template');
const PTEST_TEMPLATE = path.join(ROOT, 'ptests', 'games', '_template');
const REGISTRY = path.join(ROOT, 'shared', 'games', 'registry.js');
const LOGIC = path.join(ROOT, 'shared', 'platform', 'logic.js');
const SYNC_CONTRACTS = path.join(ROOT, 'shared', 'games', 'sync-contracts.js');

const VALID_ID = /^[a-z][a-z0-9-]*$/;
const POLICIES = new Set(['none', 'fit-square', 'piles-dynamic', 'fixed-spiral-anchor', 'pan-zoom-board']);
const SYNC_STYLES = new Set(['event-log', 'hybrid', 'board-authoritative']);

const SYNC_CONTRACT_TEMPLATES = {
    'event-log': {
        style: 'event-log',
        read: 'gameData/events',
        write: 'event-log',
        winner: 'event-log',
        review: 'none',
        notes: 'Turn-based; moves via submitMove → sendEvent. Implement GameLogic.applyMove.'
    },
    hybrid: {
        style: 'hybrid',
        read: 'global/board+events',
        write: 'event-log',
        winner: 'event-log',
        review: 'none',
        notes: 'Board snapshot on reset; moves replayed from events. Reference: piles, line.'
    },
    'board-authoritative': {
        style: 'board-authoritative',
        read: 'global/board',
        write: 'global/board',
        winner: 'host-metadata',
        review: 'none',
        notes: 'Host publishes global/board v2+ with board.seq. Guests send commands on interactions/*. Reference: bananagrams MP.'
    }
};

function die(msg) {
    console.error(`[new-game] ${msg}`);
    process.exit(1);
}

function parseArgs(argv) {
    const positional = [];
    let policy = 'fit-square';
    let sync = 'event-log';
    let mp = false;
    for (const arg of argv) {
        if (arg.startsWith('--policy=')) policy = arg.slice('--policy='.length);
        else if (arg.startsWith('--sync=')) sync = arg.slice('--sync='.length);
        else if (arg === '--mp') mp = true;
        else if (arg.startsWith('-')) die(`Unknown flag: ${arg}`);
        else positional.push(arg);
    }
    if (!POLICIES.has(policy)) die(`Invalid --policy=${policy}. Use: ${[...POLICIES].join(', ')}`);
    if (!SYNC_STYLES.has(sync)) die(`Invalid --sync=${sync}. Use: ${[...SYNC_STYLES].join(', ')}`);
    if (sync === 'board-authoritative' && !mp) {
        console.warn('[new-game] board-authoritative requires MP — enabling --mp');
        mp = true;
    }
    return { id: positional[0], label: positional[1] || positional[0], policy, sync, mp };
}

function applyReplacers(text, replacers) {
    for (const [from, to] of replacers) {
        text = typeof from === 'string' ? text.split(from).join(to) : text.replace(from, to);
    }
    return text;
}

function copyDir(src, dest, replacers = []) {
    if (!fs.existsSync(src)) die(`Missing template: ${src}`);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const from = path.join(src, name);
        const to = path.join(dest, name);
        if (fs.statSync(from).isDirectory()) {
            copyDir(from, to, replacers);
            continue;
        }
        const text = applyReplacers(fs.readFileSync(from, 'utf8'), replacers);
        fs.writeFileSync(to, text);
    }
}

function replaceInFile(file, pairs) {
    if (!fs.existsSync(file)) die(`Missing file: ${path.relative(ROOT, file)}`);
    let text = fs.readFileSync(file, 'utf8');
    for (const [from, to] of pairs) {
        if (!text.includes(from)) die(`Marker not found in ${path.relative(ROOT, file)}: ${from}`);
        text = text.replace(from, to);
    }
    fs.writeFileSync(file, text);
}

function className(id) {
    return id.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('') + 'Game';
}

function registryCapabilities(sync) {
    const cap = [
        '                ...DEFAULT_CAPABILITIES,',
        "                boardKind: 'generic',",
        `                mobileLayoutPolicy: '${'POLICY_PLACEHOLDER'}',`,
        '                auditReadyCallable: true,',
        `                syncStyle: '${sync}'`
    ];
    if (sync === 'board-authoritative') {
        cap.push('                mpBoardAuthoritative: true');
        cap.push('                supportsVictoryAutoReset: false');
        cap.push('                supportsTurnIndicator: false');
        cap.push('                supportsDragging: false');
    } else if (sync === 'hybrid') {
        cap.push('                supportsDragging: true');
    }
    return cap.join(',\n');
}

function buildRegistryBlock(id, label, policy, sync, mp) {
    const caps = registryCapabilities(sync).replace('POLICY_PLACEHOLDER', policy);
    return `        {
            id: '${id}',
            label: '${label.replace(/'/g, "\\'")}',
            logicKey: '${id}',
            modes: ['classic'],
            defaultMode: 'classic',
            capabilities: {
${caps}
            },
            globalResetKeys: ['board'],
            clearGameDataOnReset: true,
            auditConfig: 'ptests/games/${id}/desktop-sp'${mp ? `,\n            mpAuditConfig: 'ptests/games/${id}/desktop-mp'` : ''}
        },
        // NEW_GAME_REGISTRY_INSERT`;
}

function buildContractBlock(id, sync) {
    const t = SYNC_CONTRACT_TEMPLATES[sync];
    return `        ${id}: {
            style: '${t.style}',
            read: '${t.read}',
            write: '${t.write}',
            winner: '${t.winner}',
            review: '${t.review}',
            notes: '${t.notes.replace(/'/g, "\\'")}'
        },
        // NEW_GAME_CONTRACT_INSERT`;
}

function main() {
    const { id, label, policy, sync, mp } = parseArgs(process.argv.slice(2));
    if (!id) {
        console.log(`Usage: npm run new-game -- <id> "<Label>" [options]

Options:
  --sync=event-log|hybrid|board-authoritative   MP authority model (default: event-log)
  --policy=fit-square|...                       mobileLayoutPolicy (default: fit-square)
  --mp                                          include desktop-mp audit scaffold

Sync guide: games/_template/README.md#step-0--pick-sync-style-first`);
        process.exit(0);
    }
    if (!VALID_ID.test(id)) die('id must be lowercase alphanumeric (hyphens ok), e.g. my-game');

    const gameDir = path.join(ROOT, 'games', id);
    const ptestDir = path.join(ROOT, 'ptests', 'games', id);
    if (fs.existsSync(gameDir)) die(`games/${id}/ already exists`);
    if (fs.existsSync(ptestDir)) die(`ptests/games/${id}/ already exists`);

    const Pascal = className(id);
    const boardAuth = sync === 'board-authoritative';
    const replacers = [
        [/TemplateBoardAuthGame/g, Pascal],
        [/TemplateGame/g, Pascal],
        [/YOUR_GAME_ID/g, id],
        [/Template Game/g, label],
        [/initIdentity\('template'/g, `initIdentity('${id}'`]
    ];

    copyDir(GAME_TEMPLATE, gameDir, replacers);
    try { fs.unlinkSync(path.join(gameDir, 'game.js')); } catch (_) { /* optional */ }
    try { fs.unlinkSync(path.join(gameDir, 'game-board-auth.js')); } catch (_) { /* optional */ }
    try { fs.unlinkSync(path.join(gameDir, 'index-board-auth.html')); } catch (_) { /* optional */ }

    const gameSrc = boardAuth ? 'game-board-auth.js' : 'game.js';
    let gameJs = applyReplacers(fs.readFileSync(path.join(GAME_TEMPLATE, gameSrc), 'utf8'), replacers);
    fs.writeFileSync(path.join(gameDir, `${id}.js`), gameJs);

    const indexSrc = boardAuth ? 'index-board-auth.html' : 'index.html';
    let html = applyReplacers(fs.readFileSync(path.join(GAME_TEMPLATE, indexSrc), 'utf8'), replacers);
    html = html.replace(/game\.js/g, `${id}.js`);
    fs.writeFileSync(path.join(gameDir, 'index.html'), html);

    copyDir(PTEST_TEMPLATE, ptestDir, replacers);
    if (!mp) {
        try { fs.unlinkSync(path.join(ptestDir, 'desktop-mp.js')); } catch (_) { /* optional */ }
        try { fs.unlinkSync(path.join(ptestDir, 'mobile', 'mp.js')); } catch (_) { /* optional */ }
    }

    replaceInFile(REGISTRY, [['        // NEW_GAME_REGISTRY_INSERT', buildRegistryBlock(id, label, policy, sync, mp)]]);

    if (mp) {
        replaceInFile(SYNC_CONTRACTS, [['        // NEW_GAME_CONTRACT_INSERT', buildContractBlock(id, sync)]]);
    }

    const logicBlock = `    ${id}: TemplateLogic,
    // NEW_GAME_LOGIC_INSERT`;
    replaceInFile(LOGIC, [['    // NEW_GAME_LOGIC_INSERT', logicBlock]]);

    console.log(`[new-game] Created games/${id}/ and ptests/games/${id}/`);
    console.log(`[new-game] syncStyle=${sync}${mp ? ' (MP scaffold + sync-contract)' : ''}`);
    console.log('[new-game] Next:');
    console.log(`  1. Read games/_template/README.md — sync model for ${sync}`);
    console.log(`  2. Edit games/${id}/${id}.js`);
    if (sync === 'board-authoritative') {
        console.log('  3. Use MpBoardAuth + games/_template/game-board-auth.js as reference');
        console.log('  4. Study games/bananagrams/modules/mp-board.js + mp-network.js for advanced patterns');
    } else {
        console.log(`  3. Implement GameLogic.${id} in shared/platform/logic.js`);
    }
    console.log('  5. npm run sync:logic');
    console.log('  6. npm run check:sync');
    if (boardAuth) console.log('  7. npm run check:board-auth');
    console.log(`  8. npm run sp --game=${id}`);
    if (mp) console.log(`  9. node ptests/run.js mp --game=${id}`);
}

main();

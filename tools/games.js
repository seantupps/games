#!/usr/bin/env node
/**
 * Local hub stack CLI — after `npm run link`:
 *
 *   games              desktop: static :8000 + RTDB emulator
 *   games mobile       phone/LAN: static 0.0.0.0 + RTDB + phone-debug :8002
 *   games --stop
 *   games --status
 *   games --restart
 *   games mobile --restart
 */
const {
    startStack,
    stopStack,
    printStatus,
    readState
} = require('../scripts/dev/game-stack-core');

function printUsage() {
    console.log(`Usage:
  games                 start desktop stack (127.0.0.1:8000 + emulator)
  games mobile          start phone/LAN stack (+ debug :8002)
  games --stop          stop stack (desktop or mobile)
  games --status        show ports / pids
  games --restart       restart (keeps previous mode if unspecified)
  games mobile --restart

After start:
  http://127.0.0.1:8000/?room=lobby&firebase=emulator

Install shim:  npm run link
`);
}

function parseArgs(argv) {
    const flags = new Set();
    let modeExplicit = null;
    for (const a of argv) {
        if (a === 'mobile' || a === 'phone') {
            modeExplicit = 'mobile';
            continue;
        }
        if (a === 'pc' || a === 'desktop') {
            modeExplicit = 'pc';
            continue;
        }
        if (a === '-h' || a === '--help' || a === 'help') {
            flags.add('help');
            continue;
        }
        if (a.startsWith('--')) {
            flags.add(a.slice(2));
            continue;
        }
        console.error(`Unknown argument: ${a}`);
        printUsage();
        process.exit(1);
    }
    return { modeExplicit, flags };
}

async function startAndReport(mode) {
    const children = await startStack(mode);
    console.log(`\x1b[32m[games]\x1b[0m Stack started (${mode})\n`);
    for (const c of children) {
        console.log(`  ${c.tag.padEnd(12)} pid ${c.pid}  log .five/logs/${c.tag}.log`);
    }
    console.log('\n  games --status');
    console.log('  games --stop');
    if (mode === 'mobile') {
        console.log('  npm run phone:lan:urls');
    }
    console.log('\n  http://127.0.0.1:8000/?room=lobby&firebase=emulator');
    console.log('Game code changes: refresh browser — no stack restart.\n');
}

async function main() {
    const { modeExplicit, flags } = parseArgs(process.argv.slice(2));

    if (flags.has('help') || flags.has('h')) {
        printUsage();
        return;
    }

    if (flags.has('stop')) {
        console.log('\x1b[35m=== games --stop ===\x1b[0m\n');
        await stopStack();
        console.log('\x1b[32m[games]\x1b[0m Stack stopped\n');
        return;
    }

    if (flags.has('status')) {
        await printStatus();
        return;
    }

    if (flags.has('restart')) {
        const prev = readState();
        const mode = modeExplicit || prev?.mode || 'pc';
        console.log(`\x1b[35m=== games ${mode === 'mobile' ? 'mobile ' : ''}--restart ===\x1b[0m\n`);
        await stopStack();
        await startAndReport(mode);
        return;
    }

    const mode = modeExplicit || 'pc';
    const label = mode === 'mobile' ? 'games mobile' : 'games';
    console.log(`\x1b[35m=== ${label} ===\x1b[0m\n`);
    await startAndReport(mode);
}

main().catch((err) => {
    console.error('\x1b[31m[games]\x1b[0m', err.message);
    process.exit(1);
});

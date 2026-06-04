#!/usr/bin/env node
/**
 * Mobile Playwright suite — thin entry (prefer `node ptests/run.js mp --topology=mobile`).
 */
const { applyBootstrap } = require('../../shared/infra/bootstrap');
applyBootstrap(['viewportMobile']);

const { parseRunSpec, applyRunSpecEnv } = require('../../shared/infra/run-spec');
const { mainInner } = require('./run-suite');

const rawArgv = process.argv.slice(2);
const spec = parseRunSpec([...rawArgv, '--topology=mobile']);
applyRunSpecEnv(spec);

mainInner(spec).catch((err) => {
    console.error('\x1b[31m[MOBILE] Suite failed:\x1b[0m', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});

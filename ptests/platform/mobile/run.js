#!/usr/bin/env node
/**
 * Mobile suite entry — prefer: node ptests/run.js mp --topology=mobile
 */
require('../../shared/infra/bootstrap');
const { initRunConfig } = require('../../shared/infra/run-config');
const { endPlaywrightRun } = require('../../shared/infra/env-defaults');

const spec = initRunConfig(process.argv.slice(2));
if (spec.help) {
    const { printRunHelp } = require('../../shared/infra/run-spec');
    printRunHelp();
    process.exit(0);
}

const { mainInner } = require('./run-suite');

mainInner(spec)
    .catch((err) => {
        console.error(err.message || err);
        process.exitCode = 1;
    })
    .finally(() => endPlaywrightRun());

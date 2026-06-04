const { applyEnvProfiles } = require('../../shared/infra/env-defaults');
applyEnvProfiles(['stack']);

const { execSync } = require('child_process');
const path = require('path');
const { runPhonePcSync } = require('./phone_pc_sync');

const ROOT = path.join(__dirname, '../..');

async function main() {
    console.log('\x1b[35m=== Phone + PC RTDB sync test ===\x1b[0m\n');
    execSync('node scripts/test/setup-vendor-firebase.js', { cwd: ROOT, stdio: 'inherit' });
    await runPhonePcSync();
    console.log('\x1b[32mPASS\x1b[0m\n');
}

main().catch((err) => {
    console.error('\x1b[31mFAIL\x1b[0m', err.message);
    process.exit(1);
});

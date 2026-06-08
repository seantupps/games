const VERBOSE_FOCUS_DEBUG = false;

function log(msg) {
    if (!VERBOSE_FOCUS_DEBUG) {
        if (msg.startsWith('[FOCUSDBG]') || msg.startsWith('[PEELLAT]')) return;
    }
    console.log(`[TEST] ${msg}`);
}

module.exports = { log, VERBOSE_FOCUS_DEBUG };

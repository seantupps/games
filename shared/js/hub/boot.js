(function (global) {
    function init() {
        global.hubBootDismissed = false;
        global.setBootStatus = function setBootStatus(msg, ok) {
            const bar = document.getElementById('phone-boot-status');
            if (!bar) return;
            if (global.hubBootDismissed && ok !== false) return;
            bar.textContent = msg;
            bar.style.background = ok ? '#14532d' : (ok === false ? '#7f1d1d' : '#1e3a5f');
            if (ok === false) bar.style.display = '';
        };

        global.hideHubLoading = function hideHubLoading() {
            const el = document.getElementById('hub-loading');
            if (el) el.classList.add('hidden');
            if (!global.hubBootDismissed) {
                global.hubBootDismissed = true;
                global.setBootStatus('Hub ready', true);
                setTimeout(() => {
                    const bar = document.getElementById('phone-boot-status');
                    if (bar) bar.style.display = 'none';
                }, 2000);
            }
            if (global.FivePhoneDebug) global.FivePhoneDebug.flush('hub-ready');
        };

        global.setBootStatus('Loading scripts…');
        setTimeout(() => {
            const el = document.getElementById('hub-loading');
            if (el && !el.classList.contains('hidden')) {
                el.querySelector('.hub-loading-hint').textContent =
                    'Still loading? Use the full link with ?firebase=emulator. Check PC terminals :8000 and :9000 are running.';
            }
        }, 20000);
    }

    global.HubBoot = { init };
})(typeof window !== 'undefined' ? window : global);

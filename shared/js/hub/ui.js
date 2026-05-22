(function (global) {
    function attach(ctx) {
        function updateUI() {
            if (ctx.hubGames) ctx.hubGames.updateGamePickerUI();
            const input = document.getElementById('username-input');
            if (input) input.value = ctx.username;
        }
        ctx.updateUI = updateUI;

        function toggleSidebar(force) {
            const sidebar = document.getElementById('settings-sidebar');
            if (!sidebar) return;
            if (force === true) sidebar.classList.add('open');
            else if (force === false) sidebar.classList.remove('open');
            else sidebar.classList.toggle('open');
            localStorage.setItem('settingsOpen', sidebar.classList.contains('open'));
        }
        global.toggleSidebar = toggleSidebar;
        ctx.toggleSidebar = toggleSidebar;

        function showWinBanner(data) {
            const banner = document.getElementById('global-win-banner');
            if (!banner) return;

            if (data.visible) {
                const winner = data.winner;
                const isSolo = !ctx.roomId || ctx.roomId === 'lobby';
                let winnerName = '';
                let winnerColor = '#ffffff';

                if (isSolo) {
                    winnerName = winner === 'P1' ? (ctx.username || 'PLAYER') : 'AI';
                    winnerColor =
                        (winner === 'P1' ? ctx.userColor : ctx.getOpponentColor(ctx.userColor)) || '#ffffff';
                } else {
                    const rd = global.NetworkEngine.roomData;
                    if (rd?.playerData) {
                        const hostUid = rd.host;
                        const guestUid = Object.keys(rd.playerData).find((uid) => uid !== hostUid);
                        const winnerUid = winner === 'P1' ? hostUid : guestUid;
                        if (winnerUid && rd.playerData[winnerUid]) {
                            winnerName = rd.playerData[winnerUid].name;
                            winnerColor = rd.playerData[winnerUid].color;
                        }
                    }
                    if (!winnerName) {
                        winnerName = winner === 'P1' ? 'HOSTP1' : 'GUESTP2';
                    }
                    if (!winnerColor || winnerColor === '#ffffff') {
                        const myRole = global.NetworkEngine.playerRole || 'P1';
                        winnerColor = winner === myRole
                            ? ctx.userColor
                            : (document.documentElement.style.getPropertyValue('--opponent-color').trim()
                                || ctx.userColor);
                    }
                }

                banner.innerText = `${winnerName} WINS!`.toUpperCase();
                banner.style.color = winnerColor;
                banner.style.textShadow = `0 0 20px ${winnerColor}`;
                banner.classList.add('visible');
                banner.onclick = () => banner.classList.remove('visible');
            } else {
                banner.classList.remove('visible');
            }
        }
        ctx.showWinBanner = showWinBanner;

        let hubOverlayMuteUntil = 0;
        function muteHubOverlayDismiss(ms = 450) {
            hubOverlayMuteUntil = Date.now() + ms;
        }
        global.muteHubOverlayDismiss = muteHubOverlayDismiss;

        function bindMobileBarTap(el, fn) {
            if (!el) return;
            let lastHandled = 0;
            const run = (e) => {
                if (Date.now() - lastHandled < 350) return;
                lastHandled = Date.now();
                if (e.stopPropagation) e.stopPropagation();
                muteHubOverlayDismiss(80);
                fn(e);
            };
            el.addEventListener('touchend', (e) => run(e), { passive: true });
            el.addEventListener('pointerup', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                run(e);
            });
            el.addEventListener('click', (e) => run(e));
        }

        const closeHubOverlays = (e) => {
            if (Date.now() < hubOverlayMuteUntil) return;
            if (
                e.target.closest(
                    '#settings-sidebar, #settings-trigger, #chat-container, #mobile-bar, '
                    + '#mobile-fullscreen-btn, #mobile-settings-btn, #mobile-chat-btn, #mobile-settings-edge'
                )
            ) {
                return;
            }
            if (e.target.id === 'game-frame') {
                toggleSidebar(false);
                global.ChatEngine.toggle(false);
                return;
            }
            const sidebar = document.getElementById('settings-sidebar');
            const chatActive = document.getElementById('chat-container')?.classList.contains('active');
            if (!sidebar?.classList.contains('open') && !chatActive) return;
            toggleSidebar(false);
            global.ChatEngine.toggle(false);
        };
        document.addEventListener('click', closeHubOverlays, true);
        document.addEventListener('touchend', closeHubOverlays, true);
        document.addEventListener('pointerup', closeHubOverlays, true);

        bindMobileBarTap(document.getElementById('mobile-settings-btn'), () => toggleSidebar());
        bindMobileBarTap(document.getElementById('mobile-chat-btn'), () => global.ChatEngine.toggle(true));

        function syncMobileUI() {
            if (global.FiveViewport) global.FiveViewport.syncHubViewport();
        }
        window.addEventListener('resize', syncMobileUI);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', syncMobileUI);
        } else {
            syncMobileUI();
        }
    }

    global.HubUI = { attach };
})(typeof window !== 'undefined' ? window : global);

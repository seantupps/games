(function (global) {
    const Registry = global.GameRegistry;
    function attach(ctx) {
        function syncUsernameEditability() {
            const input = document.getElementById('username-input');
            const sidebar = document.getElementById('settings-sidebar');
            if (!input) return;
            const canEdit = !!sidebar?.classList.contains('open');
            input.readOnly = !canEdit;
            input.classList.toggle('is-locked', !canEdit);
        }

        function updateUI() {
            if (ctx.hubGames) ctx.hubGames.updateGamePickerUI();
            const input = document.getElementById('username-input');
            if (input) input.value = ctx.username;
            syncUsernameEditability();
        }
        ctx.updateUI = updateUI;

        function toggleSidebar(force) {
            const sidebar = document.getElementById('settings-sidebar');
            if (!sidebar) return;
            if (force === true) sidebar.classList.add('open');
            else if (force === false) sidebar.classList.remove('open');
            else sidebar.classList.toggle('open');
            localStorage.setItem('settingsOpen', sidebar.classList.contains('open'));
            syncUsernameEditability();
        }
        global.toggleSidebar = toggleSidebar;
        ctx.toggleSidebar = toggleSidebar;

        function getWinBannerViewportBox() {
            const vv = window.visualViewport;
            const pad = 12;
            const vw = vv?.width ?? window.innerWidth;
            const vh = vv?.height ?? window.innerHeight;
            const offTop = (vv?.offsetTop ?? 0) + pad;
            const offLeft = (vv?.offsetLeft ?? 0) + pad;
            return {
                maxW: Math.max(100, vw - pad * 2),
                maxH: Math.max(40, vh * 0.42 - pad),
                minTop: offTop,
                minLeft: offLeft,
                maxRight: offLeft + Math.max(100, vw - pad * 2),
                maxBottom: offTop + Math.max(40, vh - pad * 2)
            };
        }

        function isObstacleVisible(el) {
            if (!el) return false;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
                return false;
            }
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
        }

        function collectWinBannerObstacles() {
            const rects = [];
            const add = (el, id) => {
                if (!isObstacleVisible(el)) return;
                rects.push({ id, rect: el.getBoundingClientRect() });
            };
            [
                ['mobile-bar', document.getElementById('mobile-bar')],
                ['settings-trigger', document.getElementById('settings-trigger')],
                ['turn-indicator', document.getElementById('global-turn-indicator')],
                ['chat', document.getElementById('chat-container')],
                ['invite-toast', document.getElementById('invite-toast')]
            ].forEach(([id, el]) => add(el, id));
            if (document.getElementById('chat-container')?.classList.contains('active')) {
                add(document.getElementById('chat-container'), 'chat-active');
            }
            if (document.getElementById('invite-toast')?.classList.contains('show')) {
                add(document.getElementById('invite-toast'), 'invite-toast-show');
            }
            const turn = document.getElementById('global-turn-indicator');
            if (turn?.classList.contains('visible')) add(turn, 'turn-indicator-visible');

            const fdoc = document.getElementById('game-frame')?.contentDocument;
            const reviewCaps = Registry?.getCapabilities(ctx.currentGame, ctx.gameMode) || {};
            if (fdoc && reviewCaps.supportsPostGameReview) {
                [
                    ['banana-done', fdoc.getElementById('banana-done-btn')],
                    ['banana-hud', fdoc.getElementById('banana-hud')],
                    ['banana-banner', fdoc.getElementById('banana-banner')],
                    ['scoreboard', fdoc.querySelector('.scoreboard')]
                ].forEach(([id, el]) => {
                    if (id === 'banana-done' && !el?.classList.contains('show')) return;
                    if (id === 'banana-banner' && !el?.classList.contains('is-visible')) return;
                    if (id === 'scoreboard' && !el?.classList.contains('show')) return;
                    add(el, id);
                });
            }
            return rects;
        }

        function rectsOverlap(a, b, gap = 8) {
            return a.left < b.right + gap
                && a.right > b.left - gap
                && a.top < b.bottom + gap
                && a.bottom > b.top - gap;
        }

        function adjustWinBannerObstacleClearance(banner, box) {
            if (!banner || winBannerLayoutLocked) return;
            banner.style.removeProperty('top');
            banner.style.removeProperty('left');
            banner.style.transform = 'translateX(-50%)';
            const gap = 12;
            const obstacles = collectWinBannerObstacles();
            let rect = banner.getBoundingClientRect();

            for (let attempt = 0; attempt < 16; attempt++) {
                const overlapping = obstacles.filter((o) => rectsOverlap(rect, o.rect, gap));
                const outOfBox = rect.top < box.minTop
                    || rect.left < box.minLeft
                    || rect.right > box.maxRight
                    || rect.bottom > box.maxBottom;
                if (!overlapping.length && !outOfBox) break;

                let nextTop = rect.top;
                if (rect.top < box.minTop) nextTop = box.minTop;
                overlapping.forEach((o) => {
                    if (rectsOverlap(rect, o.rect, gap)) {
                        nextTop = Math.max(nextTop, o.rect.bottom + gap);
                    }
                });
                if (rect.bottom > box.maxBottom) {
                    nextTop = Math.min(nextTop, box.maxBottom - rect.height);
                }
                if (nextTop !== rect.top) {
                    banner.style.top = `${Math.ceil(nextTop)}px`;
                    banner.style.transform = 'translateX(-50%)';
                } else {
                    break;
                }
                rect = banner.getBoundingClientRect();
            }
        }

        function fitWinBannerToViewport(banner) {
            if (!banner) return;
            if (winBannerLayoutLocked || isWinBannerLocked(banner)) return;
            if (!banner.classList.contains('visible') && !banner.classList.contains('is-fitting')) return;
            const mobile = document.documentElement.classList.contains('five-mobile');
            const box = getWinBannerViewportBox();
            banner.style.removeProperty('top');
            banner.style.removeProperty('left');
            banner.style.transform = 'translateX(-50%)';
            banner.style.maxWidth = `${box.maxW}px`;
            banner.style.maxHeight = `${box.maxH}px`;
            banner.style.textAlign = 'center';
            banner.style.lineHeight = mobile ? '1.15' : '1.1';
            banner.style.whiteSpace = mobile ? 'normal' : 'nowrap';
            banner.style.overflowWrap = mobile ? 'anywhere' : 'normal';
            const preferred = mobile ? 28 : 60;
            const minSize = mobile ? 18 : 26;
            const step = 2;
            let size = preferred;
            banner.style.fontSize = `${size}px`;
            for (let i = 0; i < 48; i++) {
                const fitsMax = banner.scrollWidth <= box.maxW && banner.scrollHeight <= box.maxH;
                const fitsClient = banner.scrollHeight <= banner.clientHeight + 1
                    && banner.scrollWidth <= banner.clientWidth + 1;
                if (fitsMax && fitsClient) break;
                size = Math.max(minSize, size - step);
                banner.style.fontSize = `${size}px`;
            }
            if (banner.scrollWidth > box.maxW || banner.scrollHeight > box.maxH
                || banner.scrollHeight > banner.clientHeight + 1) {
                banner.style.whiteSpace = 'normal';
                banner.style.overflowWrap = 'anywhere';
                for (let i = 0; i < 16; i++) {
                    const fitsMax = banner.scrollWidth <= box.maxW && banner.scrollHeight <= box.maxH;
                    const fitsClient = banner.scrollHeight <= banner.clientHeight + 1
                        && banner.scrollWidth <= banner.clientWidth + 1;
                    if (fitsMax && fitsClient) break;
                    size = Math.max(minSize, size - step);
                    banner.style.fontSize = `${size}px`;
                }
            }
            adjustWinBannerObstacleClearance(banner, box);
            let rect = banner.getBoundingClientRect();
            if (rect.right > box.maxRight) {
                const left = Math.max(box.minLeft, box.maxRight - rect.width);
                banner.style.left = `${left + rect.width / 2}px`;
                banner.style.transform = 'translateX(-50%)';
            }
            rect = banner.getBoundingClientRect();
            if (rect.bottom > box.maxBottom) {
                banner.style.top = `${Math.max(box.minTop, box.maxBottom - rect.height)}px`;
            }
        }

        /** Post-game review: nudge hub banner below iframe Done if boxes overlap. */
        function adjustPostGameReviewWinBannerClearance(banner) {
            const caps = Registry?.getCapabilities(ctx.currentGame, ctx.gameMode) || {};
            if (!banner || !caps.supportsPostGameReview) return;
            adjustWinBannerObstacleClearance(banner, getWinBannerViewportBox());
        }

        let winBannerResizeBound = false;
        let winBannerFadeTimer = null;
        let winBannerSettleUntil = 0;
        let winBannerFadeCleanupTimer = null;
        let winBannerLayoutLocked = false;

        function isWinBannerLocked(banner) {
            return !!banner?.classList.contains('is-fading-out');
        }

        function lockWinBannerLayout(banner) {
            if (!banner) return;
            const rect = banner.getBoundingClientRect();
            const fs = banner.style.fontSize || getComputedStyle(banner).fontSize;
            banner.style.fontSize = fs;
            banner.style.width = `${Math.ceil(rect.width)}px`;
            banner.style.height = `${Math.ceil(rect.height)}px`;
            banner.style.maxWidth = banner.style.width;
            banner.style.maxHeight = banner.style.height;
            banner.style.transform = 'translateX(-50%) translateY(0)';
            winBannerLayoutLocked = true;
        }

        function unlockWinBannerLayout() {
            winBannerLayoutLocked = false;
        }

        function cleanupWinBannerAfterHide(banner) {
            if (!banner) return;
            unlockWinBannerLayout();
            banner.classList.remove('is-fitting', 'is-fading-out', 'visible');
            // Keep fitted dimensions off-screen until next show (avoid flash if cleanup races a frame).
            banner.style.visibility = 'hidden';
            banner.style.fontSize = '';
            banner.style.removeProperty('width');
            banner.style.removeProperty('height');
            banner.style.removeProperty('top');
            banner.style.removeProperty('left');
            banner.style.removeProperty('max-width');
            banner.style.removeProperty('max-height');
            banner.style.removeProperty('text-align');
            banner.style.removeProperty('line-height');
            banner.style.removeProperty('white-space');
            banner.style.removeProperty('overflow-wrap');
            banner.onclick = null;
        }

        function startWinBannerFadeOut(banner) {
            if (!banner || isWinBannerLocked(banner)) return;
            clearTimeout(winBannerFadeTimer);
            lockWinBannerLayout(banner);
            clearTimeout(winBannerFadeCleanupTimer);
            banner.classList.add('is-fading-out');
            banner.classList.remove('visible');
            const finish = () => {
                banner.removeEventListener('transitionend', onTransitionEnd);
                clearTimeout(winBannerFadeCleanupTimer);
                cleanupWinBannerAfterHide(banner);
            };
            const onTransitionEnd = (e) => {
                if (e.target !== banner || e.propertyName !== 'opacity') return;
                finish();
            };
            banner.addEventListener('transitionend', onTransitionEnd);
            winBannerFadeCleanupTimer = setTimeout(finish, 750);
        }

        function refitWinBannerHidden(banner) {
            if (!banner?.classList.contains('visible') || isWinBannerLocked(banner)) return;
            banner.classList.add('is-fitting');
            requestAnimationFrame(() => {
                fitWinBannerToViewport(banner);
                banner.classList.remove('is-fitting');
            });
        }

        function bindWinBannerResize() {
            if (winBannerResizeBound) return;
            winBannerResizeBound = true;
            const refit = () => {
                if (Date.now() < winBannerSettleUntil) return;
                const banner = document.getElementById('global-win-banner');
                if (!banner?.classList.contains('visible')
                    || banner.classList.contains('is-fitting')
                    || isWinBannerLocked(banner)) return;
                refitWinBannerHidden(banner);
            };
            window.addEventListener('resize', refit);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', refit);
                window.visualViewport.addEventListener('scroll', refit);
            }
            if (global.FiveHubLayout?.notifyGameFrameLayout) {
                const orig = global.FiveHubLayout.notifyGameFrameLayout.bind(global.FiveHubLayout);
                global.FiveHubLayout.notifyGameFrameLayout = function (...args) {
                    const out = orig(...args);
                    const caps = Registry?.getCapabilities(ctx.currentGame, ctx.gameMode) || {};
                    if (caps.supportsPostGameReview) {
                        const banner = document.getElementById('global-win-banner');
                        if (banner?.classList.contains('visible')
                            && !banner.classList.contains('is-fitting')
                            && !isWinBannerLocked(banner)) {
                            adjustPostGameReviewWinBannerClearance(banner);
                        }
                    } else {
                        refit();
                    }
                    return out;
                };
            }
        }

        function showWinBanner(data) {
            const banner = document.getElementById('global-win-banner');
            if (!banner) return;
            bindWinBannerResize();

            if (data.visible) {
                banner.style.visibility = '';
                if (data.bannerText) {
                    banner.innerText = data.bannerText;
                    banner.style.textTransform = 'none';
                    const color = data.bannerColor
                        || ctx.userColor
                        || '#ffffff';
                    banner.style.color = color;
                    banner.style.textShadow = `0 0 20px ${color}`;
                } else {
                    banner.style.textTransform = 'uppercase';
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
                            const resolvedUid = data.winnerUid
                                || (winner === 'P1' ? hostUid : Object.keys(rd.playerData).find((uid) => uid !== hostUid));
                            if (resolvedUid && rd.playerData[resolvedUid]) {
                                winnerName = rd.playerData[resolvedUid].name;
                                winnerColor = rd.playerData[resolvedUid].color;
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
                }
                const mobile = document.documentElement.classList.contains('five-mobile');
                banner.style.fontSize = mobile ? '28px' : '60px';
                banner.classList.remove('is-fading-out');
                winBannerSettleUntil = Date.now() + 600;
                banner.classList.add('is-fitting');
                fitWinBannerToViewport(banner);
                banner.classList.add('visible');
                banner.classList.remove('is-fitting');
                lockWinBannerLayout(banner);
                winBannerSettleUntil = Date.now() + 600;
                banner.onclick = () => {
                    clearTimeout(winBannerFadeTimer);
                    startWinBannerFadeOut(banner);
                };
                clearTimeout(winBannerFadeTimer);
                let fadeMs = data.autoFadeMs;
                if (data.visible && fadeMs == null) {
                    const envFade = typeof window.FIVE_WIN_BANNER_FADE_MS !== 'undefined'
                        ? Number(window.FIVE_WIN_BANNER_FADE_MS)
                        : NaN;
                    if (!Number.isNaN(envFade) && envFade > 0) {
                        fadeMs = envFade;
                    } else {
                        const caps = Registry?.getCapabilities(ctx.currentGame, ctx.gameMode) || {};
                        if (typeof caps.winBannerAutoFadeMs === 'number' && caps.winBannerAutoFadeMs > 0) {
                            fadeMs = caps.winBannerAutoFadeMs;
                        }
                    }
                }
                if (typeof fadeMs === 'number' && fadeMs > 0) {
                    winBannerFadeTimer = setTimeout(() => startWinBannerFadeOut(banner), fadeMs);
                }
            } else {
                clearTimeout(winBannerFadeTimer);
                clearTimeout(winBannerFadeCleanupTimer);
                if (banner.classList.contains('visible') && !isWinBannerLocked(banner)) {
                    startWinBannerFadeOut(banner);
                } else if (!isWinBannerLocked(banner)) {
                    cleanupWinBannerAfterHide(banner);
                }
            }
        }
        ctx.showWinBanner = showWinBanner;
        ctx.startWinBannerFadeOut = startWinBannerFadeOut;
        ctx.fitWinBannerToViewport = fitWinBannerToViewport;
        ctx.adjustPostGameReviewWinBannerClearance = adjustPostGameReviewWinBannerClearance;
        ctx.adjustBananagramsWinBannerClearance = adjustPostGameReviewWinBannerClearance;

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
            if (global.FiveHubLayout?.notifyGameFrameLayout) global.FiveHubLayout.notifyGameFrameLayout();
            const banner = document.getElementById('global-win-banner');
            if (banner?.classList.contains('visible') && !isWinBannerLocked(banner)) {
                fitWinBannerToViewport(banner);
            }
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

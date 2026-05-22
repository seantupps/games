/**
 * Mobile hub: visual viewport sync when chat/keyboard opens — keep board visible & chat above keyboard.
 */
(function () {
    function isMobileHub() {
        return document.documentElement.classList.contains('five-mobile');
    }

    function chatOpen() {
        return document.getElementById('chat-container')?.classList.contains('active');
    }

    function isHubTextInput(el) {
        if (!el) return false;
        const tag = el.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
        const type = (el.type || 'text').toLowerCase();
        if (type === 'color' || type === 'button' || type === 'checkbox' || type === 'hidden' || type === 'file') {
            return false;
        }
        return !!el.closest('#settings-sidebar, #chat-container');
    }

    function hubTextInputFocused() {
        return isHubTextInput(document.activeElement);
    }

    function resetChatPosition() {
        const chat = document.getElementById('chat-container');
        if (!chat) return;
        chat.style.bottom = '';
        chat.style.maxHeight = '';
    }

    function positionChatOverKeyboard() {
        const chat = document.getElementById('chat-container');
        if (!chat || !isMobileHub() || !chatOpen()) return;

        const vv = window.visualViewport;
        const layoutH = window.innerHeight;
        const vh = vv ? vv.height : layoutH;
        const top = vv ? vv.offsetTop : 0;
        const gap = 10;
        const inputFocused = hubTextInputFocused();
        const keyboardLikely = inputFocused && vv && vh < layoutH * 0.92;

        if (keyboardLikely) {
            const bottom = Math.max(gap, layoutH - (top + vh) + gap);
            chat.style.bottom = `${bottom}px`;
            chat.style.maxHeight = `${Math.max(140, vh - 48)}px`;
        } else {
            resetChatPosition();
        }
    }

    function syncVisibleViewport() {
        if (!isMobileHub()) {
            document.documentElement.classList.remove('hub-keyboard-open', 'hub-chat-open');
            return;
        }

        const vv = window.visualViewport;
        const layoutH = window.innerHeight;
        const vh = vv ? vv.height : layoutH;
        const top = vv ? vv.offsetTop : 0;
        const inputFocused = hubTextInputFocused();
        const keyboardLikely = inputFocused && vv && vh < layoutH * 0.92;

        document.documentElement.style.setProperty('--vv-height', `${Math.round(vh)}px`);
        document.documentElement.style.setProperty('--vv-top', `${Math.round(top)}px`);
        document.documentElement.classList.toggle('hub-chat-open', chatOpen());
        document.documentElement.classList.toggle('hub-keyboard-open', keyboardLikely);

        if (keyboardLikely) {
            positionChatOverKeyboard();
        } else {
            resetChatPosition();
        }

        const frame = document.getElementById('game-frame');
        if (frame?.contentWindow) {
            frame.contentWindow.postMessage({
                type: 'hub-visible-viewport',
                width: vv ? vv.width : window.innerWidth,
                height: vh,
                offsetTop: top,
                chatOpen: chatOpen(),
                keyboardOpen: keyboardLikely
            }, '*');
        }
    }

    function init() {
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', syncVisibleViewport);
            window.visualViewport.addEventListener('scroll', syncVisibleViewport);
        }
        window.addEventListener('resize', syncVisibleViewport);

        const chat = document.getElementById('chat-container');
        if (chat) {
            const obs = new MutationObserver(syncVisibleViewport);
            obs.observe(chat, { attributes: true, attributeFilter: ['class'] });
        }

        document.addEventListener('focusin', (e) => {
            if (isHubTextInput(e.target)) syncVisibleViewport();
        });
        document.addEventListener('focusout', () => {
            window.setTimeout(syncVisibleViewport, 80);
        });

        syncVisibleViewport();
    }

    window.FiveMobileHubKeyboard = {
        syncVisibleViewport,
        positionChatOverKeyboard,
        resetChatPosition
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

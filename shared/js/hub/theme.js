(function (global) {
    function attach(ctx) {
        function hexToRgbValues(hex) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return { r, g, b };
        }

        function getOpponentColor(hex) {
            const rgb = hexToRgbValues(hex);
            const toHex = (c) => (255 - c).toString(16).padStart(2, '0');
            return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
        }

        function isLobby() {
            return !ctx.roomId || ctx.roomId === 'lobby';
        }

        function postToGameFrame(message) {
            const frame = document.getElementById('game-frame');
            if (frame?.contentWindow) {
                frame.contentWindow.postMessage(message, '*');
            }
        }

        /** Solo / lobby: AI uses inverted theme color. */
        function applySoloOpponentColor() {
            const opp = getOpponentColor(ctx.userColor);
            document.documentElement.style.setProperty('--opponent-color', opp);
            const H = global.HubProtocol?.MSG || {};
            postToGameFrame({
                type: H.UPDATE_OPPONENT_THEME || 'update-opponent-theme',
                color: opp,
                name: 'AI'
            });
            return opp;
        }

        /** Multiplayer: use the other human player's RTDB color (not theme invert). */
        function syncOpponentFromRoom(roomData) {
            if (isLobby() || !roomData?.playerData || !global.NetworkEngine?.uid) {
                return null;
            }
            const opponentUid = Object.keys(roomData.playerData).find(
                (uid) => uid !== global.NetworkEngine.uid
            );
            if (!opponentUid) return null;
            const opp = roomData.playerData[opponentUid];
            if (!opp?.color) return null;

            document.documentElement.style.setProperty('--opponent-color', opp.color);
            const H = global.HubProtocol?.MSG || {};
            postToGameFrame({
                type: H.UPDATE_OPPONENT_THEME || 'update-opponent-theme',
                color: opp.color,
                name: opp.name || 'Opponent'
            });
            return opp.color;
        }

        function resolveOpponentColorForIframe() {
            if (isLobby()) {
                return getOpponentColor(ctx.userColor);
            }
            const fromRoom = syncOpponentFromRoom(global.NetworkEngine?.roomData);
            if (fromRoom) return fromRoom;
            const css = getComputedStyle(document.documentElement)
                .getPropertyValue('--opponent-color')
                .trim();
            return css || null;
        }

        function setUserColor(color) {
            ctx.userColor = color;
            sessionStorage.setItem('userColor', color);
            document.documentElement.style.setProperty('--theme-color', color);
            const rgb = hexToRgbValues(color);
            document.documentElement.style.setProperty('--theme-color-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
            const input = document.getElementById('theme-color-input');
            if (input) input.value = color;

            let opponentColorForFrame = null;
            if (isLobby()) {
                opponentColorForFrame = applySoloOpponentColor();
            } else {
                opponentColorForFrame =
                    syncOpponentFromRoom(global.NetworkEngine?.roomData) || undefined;
            }

            const H = global.HubProtocol?.MSG || {};
            const themeMsg = {
                type: H.UPDATE_THEME || 'update-theme',
                color,
                username: ctx.username,
                uid: global.NetworkEngine.uid
            };
            if (opponentColorForFrame) {
                themeMsg.opponentColor = opponentColorForFrame;
            }
            postToGameFrame(themeMsg);

            if (!isLobby() && global.NetworkEngine.isInitialized) {
                global.NetworkEngine.registerPlayerInRoom(ctx.username, color);
            }
        }

        ctx.getOpponentColor = getOpponentColor;
        ctx.applySoloOpponentColor = applySoloOpponentColor;
        ctx.syncOpponentFromRoom = syncOpponentFromRoom;
        ctx.resolveOpponentColorForIframe = resolveOpponentColorForIframe;
        ctx.setUserColor = setUserColor;
        global.setUserColor = setUserColor;
    }

    global.HubTheme = { attach };
})(typeof window !== 'undefined' ? window : global);

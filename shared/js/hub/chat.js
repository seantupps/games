(function (global) {
    function attach(ctx) {
        const ChatEngine = {
            input: null,
            container: null,
            messages: null,

            clear() {
                if (this.messages) {
                    Array.from(this.messages.children).forEach((el) => {
                        if (el._fadeTimer) clearTimeout(el._fadeTimer);
                    });
                    this.messages.innerHTML = '';
                }
            },

            _scheduleFade(el) {
                if (el._fadeTimer) clearTimeout(el._fadeTimer);
                const age = Date.now() - parseInt(el.dataset.time, 10);
                const delay = Math.max(0, 8000 - age);
                el._fadeTimer = setTimeout(() => {
                    if (!this.container.classList.contains('active')) {
                        el.classList.add('faded');
                    }
                }, delay);
            },

            _refreshFadeState() {
                Array.from(this.messages.children).forEach((el) => {
                    if (this.container.classList.contains('active')) {
                        el.classList.remove('faded');
                        if (el._fadeTimer) clearTimeout(el._fadeTimer);
                    } else {
                        this._scheduleFade(el);
                    }
                });
            },

            init() {
                this.container = document.getElementById('chat-container');
                this.messages = document.getElementById('chat-messages');
                this.input = document.getElementById('chat-input');

                this.input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const text = this.input.value.trim();
                        if (text) {
                            const isCommand = text.startsWith('/');
                            if (!isCommand) {
                                this.append({
                                    sender: ctx.username,
                                    content: text,
                                    color: ctx.userColor,
                                    uid: global.NetworkEngine.uid
                                });
                            }
                            const handled = this.handleCommand(text);
                            if (!handled && !isCommand) {
                                global.NetworkEngine.sendChatMessage(
                                    text,
                                    ctx.roomId || global.NetworkEngine.roomId
                                );
                            } else if (isCommand && !handled) {
                                this.append({
                                    sender: 'System',
                                    content: 'Unknown command. Type /help for a list.'
                                });
                            }
                            this.input.value = '';
                            requestAnimationFrame(() => this.toggle(false));
                            return;
                        }
                        this.toggle(false);
                    }
                    if (e.key === 'Escape') this.toggle(false);
                });
            },

            toggle(open, startChar = '') {
                const isOpen = typeof open === 'boolean'
                    ? open
                    : !this.container.classList.contains('active');

                if (!isOpen) {
                    this.container.classList.add('no-transition');
                }

                this.container.classList.toggle('active', isOpen);

                if (isOpen) {
                    Array.from(this.messages.children).forEach((el) => el.classList.remove('faded'));
                    this.input.value = startChar;
                    const focusChat = () => {
                        try {
                            this.input.focus({ preventScroll: true });
                        } catch (_) {
                            this.input.focus();
                        }
                    };
                    focusChat();
                    if (document.documentElement.classList.contains('five-mobile')) {
                        requestAnimationFrame(() => {
                            focusChat();
                            setTimeout(focusChat, 40);
                        });
                    }
                    if (global.FiveMobileHubKeyboard) {
                        global.FiveMobileHubKeyboard.syncVisibleViewport();
                        global.FiveMobileHubKeyboard.positionChatOverKeyboard();
                    }
                } else {
                    this.input.blur();
                    const frame = document.getElementById('game-frame');
                    if (frame) frame.focus();
                    this.container.offsetHeight;
                    this.container.classList.remove('no-transition');
                    if (global.FiveMobileHubKeyboard) {
                        global.FiveMobileHubKeyboard.syncVisibleViewport();
                    }
                }

                this._refreshFadeState();
            },

            _escapeText(str) {
                return String(str)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
            },

            append(data, isNetwork = false) {
                if (!data) return;
                const content = (data.content || (typeof data === 'string' ? data : '')).trim();
                if (!content && data.sender !== 'System') return;

                if (isNetwork && data.uid === global.NetworkEngine.uid) {
                    const existing = Array.from(this.messages.children).some(
                        (el) =>
                            el.dataset.content === content &&
                            Date.now() - parseInt(el.dataset.time, 10) < 5000
                    );
                    if (existing) return;
                }

                const div = document.createElement('div');
                div.className = `chat-msg ${!data.sender || data.sender === 'System' ? 'system' : ''}`;
                div.dataset.content = content;
                div.dataset.time = String(Date.now());

                const sender = data.sender || 'System';
                const color = data.color || (data.sender === 'System' ? '#ffffff' : 'var(--theme-color)');
                const safeSender = this._escapeText(sender);
                const safeContent = this._escapeText(content);

                if (sender === 'System') {
                    div.innerHTML =
                        `<span class="content" style="color: #ffffff !important; font-weight: 500; font-style: italic; opacity: 0.9;">${safeContent}</span>`;
                } else {
                    div.innerHTML =
                        `<span class="sender" style="color: ${color} !important; font-weight: 800;">${safeSender}:</span> ` +
                        `<span class="content" style="color: #ffffff !important;">${safeContent}</span>`;
                }

                this.messages.appendChild(div);

                while (this.messages.children.length > 7) {
                    const removed = this.messages.firstChild;
                    if (removed?._fadeTimer) clearTimeout(removed._fadeTimer);
                    this.messages.removeChild(removed);
                }

                this.messages.scrollTop = this.messages.scrollHeight;
                this._scheduleFade(div);
            },

            _hubGameMode() {
                const gameId = global.FiveHubCtx?.currentGame || 'piles';
                return global.GameRegistry?.hubModeFor
                    ? global.GameRegistry.hubModeFor(
                        gameId,
                        !!(global.FiveHubCtx?.roomId && global.FiveHubCtx.roomId !== 'lobby')
                    )
                    : (global.FiveHubCtx?.gameMode || 'classic');
            },

            _requestBoardStateInspect() {
                const gameId = global.FiveHubCtx?.currentGame || 'piles';
                const mode = this._hubGameMode();
                if (!global.GameRegistry?.hasCapability(gameId, 'supportsBoardStateInspect', mode)) {
                    this.append({
                        sender: 'System',
                        content: 'Board state inspect is not available for this game.'
                    });
                    return true;
                }
                const frame = document.getElementById('game-frame');
                if (!frame?.contentWindow) {
                    this.append({ sender: 'System', content: 'No game loaded.' });
                    return true;
                }
                const H = global.HubProtocol?.MSG || {};
                frame.contentWindow.postMessage({
                    type: H.BOARD_STATE_INSPECT || H.BANANA_BOARD_STATE || 'board-state-inspect'
                }, '*');
                return true;
            },

            _requestBoardSolve(stragglerCount) {
                const gameId = global.FiveHubCtx?.currentGame || 'piles';
                const mode = this._hubGameMode();
                if (!global.GameRegistry?.hasCapability(gameId, 'supportsBoardStateInspect', mode)) {
                    this.append({
                        sender: 'System',
                        content: 'Board solve is not available for this game.'
                    });
                    return true;
                }
                const frame = document.getElementById('game-frame');
                if (!frame?.contentWindow) {
                    this.append({ sender: 'System', content: 'No game loaded.' });
                    return true;
                }
                const H = global.HubProtocol?.MSG || {};
                frame.contentWindow.postMessage({
                    type: H.BOARD_SOLVE || 'board-solve',
                    stragglerCount
                }, '*');
                return true;
            },

            handleCommand(text) {
                const trimmed = text.trim();
                if (/^\/state(\s|$)/i.test(trimmed) || /^\/b\s+state$/i.test(trimmed)) {
                    return this._requestBoardStateInspect();
                }
                const solveMatch = /^\/solve\s+(\d+)$/i.exec(trimmed)
                    || /^\/b\s+solve\s+(\d+)$/i.exec(trimmed);
                if (solveMatch) {
                    return this._requestBoardSolve(parseInt(solveMatch[1], 10));
                }
                if (/^\/b(\s|$)/i.test(trimmed)) {
                    this.append({
                        sender: 'System',
                        content: 'Usage: /solve N (dev: stragglers left on rack / bunch remaining — game-specific)'
                    });
                    return true;
                }
                if (/^\/w(\s|$)/i.test(text)) {
                    const argText = text.substring(2).trim();
                    if (!argText) {
                        this.append({
                            sender: 'System',
                            content: 'Usage: /w word1 -word2 ... (add plain words, remove with -prefix)'
                        });
                        return true;
                    }
                    const tokens = argText.split(/\s+/).filter(Boolean);
                    const add = [];
                    const remove = [];
                    const invalid = [];
                    tokens.forEach((tok) => {
                        const isRemove = tok.startsWith('-');
                        const word = (isRemove ? tok.slice(1) : tok).trim().toLowerCase();
                        if (!/^[a-z]+$/.test(word)) {
                            invalid.push(tok);
                            return;
                        }
                        if (isRemove) remove.push(word);
                        else add.push(word);
                    });
                    if (!add.length && !remove.length) {
                        this.append({
                            sender: 'System',
                            content: `No valid words in command.${invalid.length ? ` Invalid: ${invalid.join(', ')}` : ''}`
                        });
                        return true;
                    }
                    const frame = document.getElementById('game-frame');
                    if (!frame?.contentWindow) {
                        this.append({ sender: 'System', content: 'No game loaded.' });
                        return true;
                    }
                    frame.contentWindow.postMessage({
                        type: (global.HubProtocol?.MSG?.DICT_ADJUST || 'dict-adjust'),
                        adjustments: { add, remove }
                    }, '*');
                    return true;
                }
                if (text.toLowerCase() === '/p leave') {
                    ctx.leaveParty();
                    return true;
                }
                if (text.toLowerCase() === '/help' || text.toLowerCase().startsWith('/help ')) {
                    [
                        '/p <name> — invite a player to your party',
                        '/p leave — leave the party and return to the lobby',
                        '/w word1 -word2 ... — add/remove dictionary words',
                        '/state — board progress (unmatched tiles, invalid words, win-ready, etc.)',
                        '/solve N — dev only: solve current tiles (N stragglers — rack or bunch, game-specific)',
                        '/undo — SP: undo last player move + AI reply (Quoridor)',
                        '/clear — clear local data and reload',
                        '/win — dev win (same review + hub banner path as real MP win)',
                        '/win banner <name> — hub win banner only (dev)',
                        '/help — show this list'
                    ].forEach((line) => this.append({ sender: 'System', content: line }));
                    return true;
                }
                if (text.startsWith('/p ')) {
                    const targetName = text.substring(3).trim();
                    global.NetworkEngine.findUserByName(targetName, (user) => {
                        if (user) {
                            ctx.sendInvite(user.uid, user.name);
                        } else {
                            this.append({ sender: 'System', content: `User "${targetName}" not found.` });
                        }
                    });
                    return true;
                }
                if (text.startsWith('/clear')) {
                    if (confirm('Clear all game data, scores, and settings?')) {
                        localStorage.clear();
                        window.location.reload();
                    }
                    return true;
                }
                if (text.trim().toLowerCase() === '/win') {
                    const frame = document.getElementById('game-frame');
                    if (frame?.contentWindow) {
                        frame.contentWindow.postMessage({ type: 'dev-win' }, '*');
                        this.append({
                            sender: 'System',
                            content: 'Triggered in-game win (dev).'
                        });
                    } else {
                        this.append({ sender: 'System', content: 'No game loaded.' });
                    }
                    return true;
                }
                if (/^\/undo$/i.test(trimmed) || /^\/u$/i.test(trimmed)) {
                    const frame = document.getElementById('game-frame');
                    if (!frame?.contentWindow) {
                        this.append({ sender: 'System', content: 'No game loaded.' });
                        return true;
                    }
                    const H = global.HubProtocol?.MSG || {};
                    frame.contentWindow.postMessage({ type: H.UNDO || 'undo' }, '*');
                    this.append({
                        sender: 'System',
                        content: 'Undo: last player move + AI reply (if supported).'
                    });
                    return true;
                }
                if (text.toLowerCase().startsWith('/win banner ')) {
                    const target = text.substring(12).trim();
                    const myName = ctx.username || 'Guest';
                    const winner = target.toUpperCase() === myName.toUpperCase() ? 'P1' : 'P2';
                    ctx.showWinBanner({ winner, visible: true });
                    return true;
                }
                return false;
            }
        };

        ChatEngine.init();
        global.ChatEngine = ChatEngine;
        ctx.appendChatMessage = (data) => ChatEngine.append(data, true);
        global.appendChatMessage = ctx.appendChatMessage;
    }

    global.HubChat = { attach };
})(typeof window !== 'undefined' ? window : global);

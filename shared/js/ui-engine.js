/**
 * BaseGame class providing core turn management and state handling.
 */
class BaseGame {
    constructor() {
        this.turn = 'P1';
        this.isOver = false;
        this.winner = null;
    }

    setGameOver(winner) {
        this.isOver = true;
        this.winner = winner;
        this.renderWinOverlay(winner === 'P1' ? 'PLAYER 1 WINS' : 'AI WINS');
    }

    renderWinOverlay(message) {
        let overlay = document.querySelector('.win-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'win-overlay';
            document.body.appendChild(overlay);
        }
        overlay.innerText = message;
        // Trigger reflow for transition
        overlay.offsetHeight;
        overlay.classList.add('show');
    }

    clearWinOverlay() {
        const overlay = document.querySelector('.win-overlay');
        if (overlay) overlay.classList.remove('show');
    }

    static setupDragging(el, onDragEnd, context) {
        let startX, startY;
        let isDragging = false;
        let xOffset = 0, yOffset = 0;
        const threshold = 5;

        el.onmousedown = (e) => {
            if (context && (context.turn !== 'P1' || context.isOver)) return;

            startX = e.clientX;
            startY = e.clientY;

            const rect = el.getBoundingClientRect();
            xOffset = e.clientX - rect.left;
            yOffset = e.clientY - rect.top;

            document.onmousemove = (me) => {
                if (Math.abs(me.clientX - startX) > threshold || Math.abs(me.clientY - startY) > threshold) {
                    isDragging = true;
                }

                if (isDragging) {
                    el.style.left = `${me.clientX - xOffset}px`;
                    el.style.top = `${me.clientY - yOffset}px`;
                }
            };

            document.onmouseup = (ue) => {
                document.onmousemove = null;
                document.onmouseup = null;

                if (onDragEnd) {
                    onDragEnd(isDragging, el, ue);
                }
                isDragging = false;
            };
        };
    }
}

// Global key listeners
window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key.toLowerCase() === 's') {
        window.parent.postMessage('toggle-settings', '*');
    }
    if (e.key.toLowerCase() === 'g') {
        window.parent.postMessage('switch-game', '*');
    }
});

window.BaseGame = BaseGame;

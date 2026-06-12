const game = new RummikubGame();
const _bootContainer = document.getElementById('game-container');
if (_bootContainer && !document.getElementById('rummikub-timer')) {
    const hud = document.createElement('div');
    hud.className = 'rummikub-hud';
    hud.innerHTML = '<div id="rummikub-timer" class="game-timer" data-testid="game-timer">0:00</div>';
    _bootContainer.appendChild(hud);
}

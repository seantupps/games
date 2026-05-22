/**
 * Template — copy to games/<id>/<id>.js and rename class.
 * Rules live in shared/platform/logic.js (GameLogic.<id>).
 */
class TemplateGame extends BaseGame {
    constructor() {
        super();
        const urlParams = new URLSearchParams(window.location.search);
        this.mode = urlParams.get('mode') || 'classic';
        this.initIdentity('template', this.mode);
        window.game = this;
    }

    getValidMoves() {
        return [];
    }

    serializeBoard() {
        return { initialized: true };
    }

    applyBoard(board) {
        if (board && typeof this.applyState === 'function') this.applyState(board);
    }

    onGameReset() {
        this.requestRender();
    }

    _render() {
        // draw UI
    }
}

const game = new TemplateGame();

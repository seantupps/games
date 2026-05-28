/**
 * Opponent line-preview sync (supportsRealtimePreviews).
 */
(function (global) {
  function handlePreviews(game, data) {
    if (!game.hasCap?.('supportsRealtimePreviews')) return;

    if (data.previews) {
      const myUid = game.uid || sessionStorage.getItem('game_uid') || localStorage.getItem('game_uid');
      const PM = global.PlayerModel;
      const otherUid = PM?.firstOtherUid(data, myUid)
        || Object.keys(data.previews).find((uid) => uid !== myUid);
      if (otherUid) {
        const previewVal = data.previews[otherUid];
        game.opponentPreview = previewVal
          ? { start: previewVal.start, nx: previewVal.nx, ny: previewVal.ny }
          : null;
      } else {
        game.opponentPreview = null;
      }
      game.safeRender();
    } else if ('previews' in data && !data.previews) {
      game.opponentPreview = null;
      game.safeRender();
    }
  }

  global.EngineNetwork = global.EngineNetwork || {};
  global.EngineNetwork.preview = { handlePreviews };
})(typeof window !== 'undefined' ? window : global);

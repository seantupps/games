/**
 * Dev bundle entry — patches BananagramsGame for /b solve only.
 * Not loaded in production builds that omit games/bananagrams/dev/*.
 */
(function (global) {
    const G = global.BananagramsGame;
    const Dev = global.BananaDev;
    if (!G || !Dev?.boardSolveMethods) return;
    Object.assign(G.prototype, Dev.boardSolveMethods);
})(typeof window !== 'undefined' ? window : global);

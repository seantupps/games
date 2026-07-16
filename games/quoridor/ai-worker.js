/* global QuoridorEngine */
"use strict";
importScripts("./engine.js");

self.onmessage = function (ev) {
    const msg = ev.data || {};
    if (msg.type === "warmup") {
        const g = new QuoridorEngine.Engine();
        QuoridorEngine.chooseGreedy(g);
        self.postMessage({ type: "ready" });
        return;
    }
    if (msg.type === "choose") {
        const g = QuoridorEngine.Engine.fromJSON(msg.state);
        const move = QuoridorEngine.chooseGreedy(g);
        self.postMessage({ type: "move", move: move, id: msg.id });
    }
};

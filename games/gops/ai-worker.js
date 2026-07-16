/* global GopsEngine */
"use strict";
importScripts("./engine.js");

const GOPS_AI_URL = "/gops-ai/bid";
const GOPS_AI_PING = "/gops-ai/ping";

async function pingNash() {
    try {
        const res = await fetch(GOPS_AI_PING, { method: "GET", cache: "no-store" });
        if (!res.ok) return false;
        const data = await res.json();
        return !!(data && data.ok);
    } catch {
        return false;
    }
}

async function nashRequest(state, extra = {}) {
    const res = await fetch(GOPS_AI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...state, mixes: true, ...extra }),
        cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error((data && data.error) || `gops-ai HTTP ${res.status}`);
    }
    return data;
}

function metaFromNash(data, source) {
    return {
        source,
        mode: data.mode,
        ms: data.ms,
        http_ms: data.http_ms,
        rem: data.rem,
        chances: data.chances,
        mixes: data.mixes || [],
        turn_line: data.turn_line,
        value: data.value,
    };
}

self.onmessage = async function (ev) {
    const msg = ev.data || {};
    if (msg.type === "warmup") {
        const ok = await pingNash();
        if (!ok) {
            const g = new GopsEngine.Engine({ n: 13, seed: 1 });
            g.revealNextPrize();
            GopsEngine.chooseAiBid(g);
        }
        self.postMessage({ type: "ready", nash: ok });
        return;
    }
    if (msg.type === "eval") {
        try {
            const data = await nashRequest(msg.state, { evalOnly: true });
            self.postMessage({
                type: "eval",
                meta: metaFromNash(data, "nash"),
            });
        } catch (err) {
            self.postMessage({
                type: "eval",
                meta: {
                    source: "heuristic",
                    error: err && err.message ? err.message : String(err),
                },
            });
        }
        return;
    }
    if (msg.type === "choose") {
        const g = GopsEngine.Engine.fromJSON(msg.state);
        let bid = null;
        let meta = { source: "heuristic" };
        try {
            const data = await nashRequest(msg.state);
            if (!data.bid) throw new Error(data.error || "no bid");
            bid = data.bid;
            meta = metaFromNash(data, "nash");
        } catch (err) {
            console.warn(
                "[gops-ai] Nash unavailable, heuristic:",
                err && err.message ? err.message : err
            );
            bid = GopsEngine.chooseAiBid(g);
            meta = { source: "heuristic", error: err && err.message ? err.message : String(err) };
        }
        if (!bid || !g.aiHand.includes(bid)) {
            bid = GopsEngine.chooseAiBid(g);
            meta = { source: "heuristic" };
        }
        self.postMessage({ type: "move", bid, id: msg.id, meta });
    }
};

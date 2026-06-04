const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const MAGIC = 'BNWL';
const HEADER_SIZE = 24;

class Dictionary {
    constructor(filePath) {
        this.nodes = [];
        this.minLen = 0;
        this.maxLen = 0;
        this.lexicon = '';
        if (filePath) {
            this.load(filePath);
        }
    }

    load(filePath) {
        let buffer = fs.readFileSync(filePath);
        if (filePath.endsWith('.gz')) {
            buffer = zlib.gunzipSync(buffer);
        }

        const magic = buffer.toString('utf8', 0, 4);
        if (magic !== MAGIC) {
            throw new Error(`Not a BNWL file: ${filePath}`);
        }

        const version = buffer.readUInt32LE(4);
        const lexiconId = buffer.readUInt32LE(8);
        const wordCount = buffer.readUInt32LE(12);
        const nodeCount = buffer.readUInt32LE(16);
        this.minLen = buffer.readUInt8(20);
        this.maxLen = buffer.readUInt8(21);

        this._wordCount = wordCount;
        this._nodeCount = nodeCount;
        this._path = filePath;

        if (!process.env.BANANA_AI_QUIET) {
            console.log(`[AI-DICT] Loaded dictionary: nodes=${nodeCount} words=${wordCount} min=${this.minLen} max=${this.maxLen}`);
        }
        if (nodeCount === 0 && !process.env.BANANA_AI_QUIET) {
            console.error('[AI-DICT] WARNING: Dictionary has 0 nodes!');
        }

        let offset = HEADER_SIZE;
        for (let i = 0; i < nodeCount; i++) {
            const flags = buffer.readUInt8(offset++);
            const childCount = buffer.readUInt8(offset++);
            const children = {};
            for (let j = 0; j < childCount; j++) {
                const char = String.fromCharCode(buffer.readUInt8(offset++));
                const childIdx = buffer.readUInt32LE(offset);
                offset += 4;
                children[char] = childIdx;
            }
            this.nodes.push({ terminal: !!(flags & 1), children });
        }
    }

    isWord(word) {
        const w = word.toLowerCase();
        if (w.length < this.minLen || w.length > this.maxLen) return false;

        let idx = 0;
        for (const char of w) {
            const node = this.nodes[idx];
            if (!(char in node.children)) return false;
            idx = node.children[char];
        }
        return this.nodes[idx].terminal;
    }

    /** Words formable from rack multiset (cached). */
    rackWords(rack, limit = 40) {
        const { rackCountsKey } = require('./grid');
        const { wordsFromCounts } = require('./solver');
        const counts = rackCountsKey(rack);
        const cap = Math.min(this.maxLen, counts.reduce((s, n) => s + n, 0));
        if (cap < this.minLen) return [];
        const cacheKey = `${counts.join(',')}|${cap}|${limit}`;
        if (!this._rackCache) this._rackCache = new Map();
        if (this._rackCache.has(cacheKey)) {
            return [...this._rackCache.get(cacheKey)];
        }
        const hit = wordsFromCounts(this.nodes, this.minLen, cap, counts, limit);
        this._rackCache.set(cacheKey, hit);
        return hit;
    }
}

const _cachedDicts = new Map();

function getDictionary(dictPath) {
    const defaultPath = path.resolve(__dirname, '../../../../games/bananagrams/dict/enable.bin.gz');
    const p = dictPath || defaultPath;
    if (_cachedDicts.has(p)) return _cachedDicts.get(p);
    const d = new Dictionary(p);
    _cachedDicts.set(p, d);
    return d;
}

module.exports = { Dictionary, getDictionary };

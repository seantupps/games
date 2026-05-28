/**
 * BNWL compressed dictionary loader (kept out of engine / shared platform).
 */
(function (global) {
    const MAGIC = 0x4c574e42; // 'BNWL' LE

    function parseHeader(view) {
        const magic = view.getUint32(0, true);
        if (magic !== MAGIC) throw new Error('BNWL: bad magic');
        return {
            version: view.getUint32(4, true),
            lexicon: view.getUint32(8, true),
            wordCount: view.getUint32(12, true),
            nodeCount: view.getUint32(16, true),
            minLen: view.getUint8(20),
            maxLen: view.getUint8(21),
            headerBytes: 24
        };
    }

    function parseNodes(buffer, header) {
        const view = new DataView(buffer);
        let off = header.headerBytes;
        const nodes = [];
        for (let i = 0; i < header.nodeCount; i++) {
            const flags = view.getUint8(off++);
            const n = view.getUint8(off++);
            const children = [];
            for (let c = 0; c < n; c++) {
                const letter = String.fromCharCode(view.getUint8(off++));
                const child = view.getUint32(off, true);
                off += 4;
                children.push({ letter, child });
            }
            nodes.push({ terminal: !!(flags & 1), children });
        }
        return nodes;
    }

    async function loadWordlist(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`wordlist fetch ${response.status}`);
        const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
        const buffer = await new Response(stream).arrayBuffer();
        const view = new DataView(buffer);
        const header = parseHeader(view);
        const nodes = parseNodes(buffer, header);
        return { header, nodes };
    }

    function createChecker(nodes) {
        const norm = (str) => str.toLowerCase();
        return {
            isPrefix(str) {
                const s = norm(str);
                let idx = 0;
                for (let i = 0; i < s.length; i++) {
                    const node = nodes[idx];
                    const ch = s[i];
                    let next = -1;
                    for (const { letter, child } of node.children) {
                        if (letter === ch) { next = child; break; }
                    }
                    if (next < 0) return false;
                    idx = next;
                }
                return true;
            },
            isWord(str) {
                const s = norm(str);
                if (!s.length) return false;
                let idx = 0;
                for (let i = 0; i < s.length; i++) {
                    const node = nodes[idx];
                    const ch = s[i];
                    let next = -1;
                    for (const { letter, child } of node.children) {
                        if (letter === ch) { next = child; break; }
                    }
                    if (next < 0) return false;
                    idx = next;
                }
                return nodes[idx].terminal;
            }
        };
    }

    const BananaDictionary = { loadWordlist, createChecker, parseHeader, parseNodes };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BananaDictionary;
    } else {
        global.BananaDictionary = BananaDictionary;
    }
})(typeof window !== 'undefined' ? window : global);

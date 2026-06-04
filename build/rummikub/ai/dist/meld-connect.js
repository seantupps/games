import { assignJokersToMeld } from './validate.js';
export function summarizeMeld(meld) {
    const assigned = assignJokersToMeld(meld);
    if (!assigned)
        return null;
    if (meld.kind === 'run') {
        const values = assigned.map((a) => a.value);
        return {
            kind: 'run',
            color: assigned[0].color,
            min: Math.min(...values),
            max: Math.max(...values)
        };
    }
    return {
        kind: 'group',
        value: assigned[0].value,
        colors: new Set(assigned.map((a) => a.color))
    };
}
/** True if two melds could be merged into one valid run or group on the table. */
export function meldsCanConnect(a, b) {
    if (a.kind === 'run' && b.kind === 'run') {
        if (a.color !== b.color)
            return false;
        return a.max + 1 >= b.min && b.max + 1 >= a.min;
    }
    if (a.kind === 'group' && b.kind === 'group') {
        if (a.value !== b.value)
            return false;
        for (const c of a.colors) {
            if (b.colors.has(c))
                return false;
        }
        return a.colors.size + b.colors.size <= 4;
    }
    return false;
}
export function canConnectToAny(candidate, existing) {
    const cs = summarizeMeld(candidate);
    if (!cs)
        return true;
    for (const e of existing) {
        const es = summarizeMeld(e);
        if (es && meldsCanConnect(cs, es))
            return true;
    }
    return false;
}
export function boardHasConnectablePair(melds) {
    const summaries = melds.map(summarizeMeld).filter(Boolean);
    for (let i = 0; i < summaries.length; i++) {
        for (let j = i + 1; j < summaries.length; j++) {
            if (meldsCanConnect(summaries[i], summaries[j]))
                return true;
        }
    }
    return false;
}
//# sourceMappingURL=meld-connect.js.map
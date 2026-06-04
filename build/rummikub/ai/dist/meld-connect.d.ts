import type { Color, Meld } from './types.js';
export interface RunSummary {
    kind: 'run';
    color: Color;
    min: number;
    max: number;
}
export interface GroupSummary {
    kind: 'group';
    value: number;
    colors: Set<Color>;
}
export type MeldSummary = RunSummary | GroupSummary;
export declare function summarizeMeld(meld: Meld): MeldSummary | null;
/** True if two melds could be merged into one valid run or group on the table. */
export declare function meldsCanConnect(a: MeldSummary, b: MeldSummary): boolean;
export declare function canConnectToAny(candidate: Meld, existing: Meld[]): boolean;
export declare function boardHasConnectablePair(melds: Meld[]): boolean;

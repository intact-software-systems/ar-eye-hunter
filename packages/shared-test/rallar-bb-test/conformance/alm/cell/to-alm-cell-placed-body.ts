import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCellParts } from '../alm-conformance-cell-parts.ts';
import { toAlmCellArming } from './to-alm-cell-arming.ts';

/**
 * A role's body for a cell without a settle: its start state leads it after its cue subscription, where the cell's
 * pages are armed. A barriered cell writes the start state in its settle instead, so every cell places it once.
 */
export function toAlmCellPlacedBody(parts: AlmConformanceCellParts): readonly RallarBlackBoxTestCommand[] {
    const { arming, rest } = toAlmCellArming(parts.body);
    return [...arming, ...parts.startState, ...rest];
}

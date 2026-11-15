import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCellParts } from '../alm-conformance-cell-parts.ts';
import { toAlmCellArming } from './to-alm-cell-arming.ts';

/**
 * A role's body for a cell without a settle: its start state leads it after its cue subscription, where the cell's
 * pages are armed. A barriered cell writes the start state in its settle instead, so every cell places it once. A cell
 * that reshapes its room gets no reshape settle here: nothing holds its first send until every page accepted the
 * reshaped layout and the replaced layout's forwarding window ended, so its relay and ordering claims hold only by
 * timing. No runner runs one: the hosted manifests withhold `receipted-relay-path` and create no granted relay cell, and
 * the lane plans from unsettled cells but runs barriered ones.
 */
export function toAlmCellPlacedBody(parts: AlmConformanceCellParts): readonly RallarBlackBoxTestCommand[] {
    const { arming, rest } = toAlmCellArming(parts.body);
    return [...arming, ...parts.startState, ...rest];
}

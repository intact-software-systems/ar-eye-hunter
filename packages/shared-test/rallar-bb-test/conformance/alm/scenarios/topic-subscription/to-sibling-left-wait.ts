import type { RallarBlackBoxTestWaitCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toAlmCellBarrierCommandId } from '../../cell/to-alm-cell-barrier.ts';
import { toAlmCellCommandPrefix } from '../../cell/to-alm-cell-command-prefix.ts';
import { toHeldGroupAppliedMatch } from '../../cell/to-held-group-applied-match.ts';
import { SUBSCRIPTION_PHASE_MS } from '../../granted-topic/subscription-phase-budgets.ts';

/**
 * The page applied a room snapshot with one session fewer than the cell's roles: the sibling's session left the room.
 * The count is read from the cell's `armed` barrier onward, when every role connected, so the one way to reach it is a
 * removal; the cell's room is its own, so no session of an earlier cell is left in it. It only works in a cell created
 * with `cellSettle: 'barriered'`: without an `armed` command the page falls back to the next event and the wait times
 * out, so a hosted manifest for this cell must carry an `armed` barrier.
 */
export function toSiblingLeftWait(step: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, 'sibling-left'),
        match: {
            ...toHeldGroupAppliedMatch(step, { 'data.activeSessionCount': step.roles.length - 1 }),
            sinceCommandIdPrefix: toAlmCellBarrierCommandId({
                cellPrefix: toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey),
                role: step.role,
                phase: 'armed'
            })
        },
        timeoutMs: SUBSCRIPTION_PHASE_MS
    };
}

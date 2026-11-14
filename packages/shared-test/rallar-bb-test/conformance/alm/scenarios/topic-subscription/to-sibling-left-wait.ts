import type { RallarBlackBoxTestWaitCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toAlmCellBarrierCommandId } from '../../cell/to-alm-cell-barrier.ts';
import { toAlmCellCommandPrefix } from '../../cell/to-alm-cell-command-prefix.ts';
import { SUBSCRIPTION_PHASE_MS } from '../../granted-topic/subscription-phase-budgets.ts';

/**
 * The page applied a room snapshot with one session fewer than the cell's roles: the sibling's session left the room.
 * The count is read from the cell's `armed` barrier onward, when every role connected, so the one way to reach it is a
 * removal; the cell's room is its own, so no session of an earlier cell is left in it.
 */
export function toSiblingLeftWait(step: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    const group = step.input.group;
    return {
        kind: 'wait',
        commandId: toCommandId(step, 'sibling-left'),
        match: {
            kind: 'diagnostic',
            topic: 'rallar.browser.group_state.applied',
            payloadFields: {
                'data.change': 'held',
                'data.groupRef.applicationId': group.applicationId,
                'data.groupRef.workspaceId': group.workspaceId,
                'data.groupRef.groupId': group.groupId,
                'data.activeSessionCount': step.roles.length - 1
            },
            sinceCommandIdPrefix: toAlmCellBarrierCommandId({
                cellPrefix: toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey),
                role: step.role,
                phase: 'armed'
            })
        },
        timeoutMs: SUBSCRIPTION_PHASE_MS
    };
}

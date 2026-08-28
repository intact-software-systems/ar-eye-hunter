import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { serializeCanonicalJson } from '../protocol/canonical-json.ts';
import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';

/**
 * The route-less promotion command (plan slice 4a): the transaction that
 * accepts an apply-role planned publication enqueues it, so process loss
 * cannot strand promotion. The id spells the full fence — group, epoch and
 * planned identity — making identical replay an inbox replay and any other
 * delivery a typed fence outcome, never a second promotion.
 */
export function toApplyPlannedLayoutCommand(
    input: Readonly<{
        groupRef: GroupRef;
        formationEpoch: number;
        expectedLayout: GroupLayoutIdentity;
    }>
): GroupMutationCommand {
    const identity = serializeCanonicalJson({
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        expectedLayout: input.expectedLayout
    });
    const commandId = `topology-publication:v1:apply:${identity}`;
    return {
        operation: 'applyPlannedLayout',
        aggregateRef: input.groupRef,
        commandId,
        requestId: commandId,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            expectedFormationEpoch: input.formationEpoch,
            expectedLayout: input.expectedLayout
        }
    };
}

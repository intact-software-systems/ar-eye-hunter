import type { Group } from '@shared/api/group-types.ts';

import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { auditStamp, computeGroupMutationWriteResult, noOp, rejected, requireGroup } from '../group-mutation-result.ts';
import { computePlannedLayoutPromotion } from './compute-planned-layout-promotion.ts';
import { assertActive } from './group-aggregate-mutation-policy.ts';

/**
 * The no-transition promotion path (plan slice 4a, product decision 27): the
 * accepted planned publication's transaction enqueued this command, and here
 * it applies the same canonical promotion activation uses — without touching
 * stage, epoch, electorate or attempt count. Identical replay is a no-op
 * success; stale authority is a typed rejection that writes nothing.
 */
export function computeApplyPlannedLayout(
    command: Extract<GroupMutationCommand, { operation: 'applyPlannedLayout'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    if (stored.value.lifecycleState !== 'active') {
        // Promotion without a transition is an active-group operation; a
        // connecting group promotes only through its activation.
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Planned layout promotion requires an active group, not ${stored.value.lifecycleState}`
        });
    }
    const promotion = computePlannedLayoutPromotion({
        expectedFormationEpoch: command.input.expectedFormationEpoch,
        expectedLayout: command.input.expectedLayout,
        currentFormationEpoch: stored.value.formationEpoch,
        planned: read.plannedLayoutRow,
        acceptedIdentity: stored.value.acceptedLayoutIdentity,
        acceptedRow: read.acceptedLayoutRow
    });
    if (promotion.outcome === 'already-applied') {
        return noOp(command, read, facts);
    }
    if (promotion.outcome !== 'apply') {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Planned layout promotion is ${promotion.outcome}`
        });
    }
    const next: Group = {
        ...stored.value,
        acceptedLayoutIdentity: promotion.acceptedIdentity,
        snapshotVersion: stored.value.snapshotVersion + 1,
        updated: auditStamp(command, facts, undefined)
    };
    return computeGroupMutationWriteResult({
        acceptedLayoutPromotion: promotion,
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            value: next,
            expectedRevision: stored.entry.revision
        },
        members: [],
        initialPresenceSummary: null,
        presenceAdmission: null,
        eventType: 'group-updated',
        presenceSummaryWork: 'enqueue'
    });
}

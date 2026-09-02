import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { computeRuntimeStateGuardedBatch } from '../../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch.ts';
import {
    type RuntimeStateGuardedBatchComputed,
    type RuntimeStateGuardedBatchEffect,
    type RuntimeStateGuardedBatchGuard
} from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import {
    groupStateInsertGroupDescriptor,
    groupStateUpdateGroupDescriptor
} from '../../persistence/aggregate/group-aggregate-write-descriptors.ts';
import { groupStateInsertIdempotencyDescriptor } from '../../persistence/idempotency/group-state-insert-idempotency-descriptor.ts';
import {
    toGroupLayoutPromotionEffects,
    toGroupLayoutTombstoneEffects,
    toPlannedLayoutFenceEffect
} from '../../persistence/layout/to-group-layout-promotion-effects.ts';
import { groupStateMemberPutDescriptor } from '../../persistence/membership/group-state-member-put-descriptor.ts';
import {
    groupStateDeletePresenceDescriptor,
    groupStateInsertPresenceAdmissionDescriptor,
    groupStateInsertPresenceDescriptor,
    groupStateInsertPresenceSummaryDescriptor,
    groupStateUpdatePresenceAdmissionDescriptor,
    groupStateUpdatePresenceDescriptor,
    groupStateUpdatePresenceSummaryDescriptor
} from '../../persistence/presence/group-presence-write-descriptors.ts';
import type { GroupMutationComputedWrite } from '../group-mutation-contracts.ts';

export function computeGroupStateGuardedBatch(
    computed: Omit<GroupMutationComputedWrite, 'guardedBatch'>
): RuntimeStateGuardedBatchComputed {
    const effects: RuntimeStateGuardedBatchEffect[] = [];

    if (computed.presenceAdmission) {
        const admission = computed.presenceAdmission;
        effects.push({
            effectId: 'presence-admission',
            ...(admission.operation === 'insert'
                ? groupStateInsertPresenceAdmissionDescriptor(admission.value)
                : groupStateUpdatePresenceAdmissionDescriptor(admission.value, admission.expectedRevision))
        });
    }

    for (const member of computed.members) {
        effects.push({
            effectId: `member:${member.principalId}`,
            ...groupStateMemberPutDescriptor(member)
        });
    }

    if (computed.initialPresenceSummary) {
        const summary = computed.initialPresenceSummary;
        effects.push({
            effectId: 'initial-presence-summary',
            ...(summary.operation === 'insert'
                ? groupStateInsertPresenceSummaryDescriptor(summary.value)
                : groupStateUpdatePresenceSummaryDescriptor(summary.value, summary.expectedRevision))
        });
    }

    if (computed.acceptedLayoutPromotion) {
        effects.push(...toGroupLayoutPromotionEffects(computed.acceptedLayoutPromotion));
    }

    if (computed.layoutTombstones) {
        effects.push(...toGroupLayoutTombstoneEffects(computed.layoutTombstones));
    }

    if (computed.plannedLayoutFence) {
        effects.push(toPlannedLayoutFenceEffect(computed.plannedLayoutFence));
    }

    if (computed.connectTriggerLatchEffect) {
        effects.push(computed.connectTriggerLatchEffect);
    }

    if (computed.idempotency) {
        effects.push({
            effectId: 'receipt',
            ...groupStateInsertIdempotencyDescriptor(computed.idempotency, NEVER_EXPIRE_AT_TIMESTAMP)
        });
    }

    return computeRuntimeStateGuardedBatch({
        guard: computeGuard(computed),
        effects
    });
}

function computeGuard(computed: Omit<GroupMutationComputedWrite, 'guardedBatch'>): RuntimeStateGuardedBatchGuard {
    const guard = computed.guard;
    if (guard.kind === 'group') {
        return guard.operation === 'insert'
            ? groupStateInsertGroupDescriptor(guard.value)
            : groupStateUpdateGroupDescriptor(guard.value, guard.expectedRevision);
    }
    if (guard.operation === 'delete') {
        return groupStateDeletePresenceDescriptor(guard.value, guard.expectedRevision);
    }
    return guard.operation === 'insert'
        ? groupStateInsertPresenceDescriptor(guard.value)
        : groupStateUpdatePresenceDescriptor(guard.value, guard.expectedRevision);
}


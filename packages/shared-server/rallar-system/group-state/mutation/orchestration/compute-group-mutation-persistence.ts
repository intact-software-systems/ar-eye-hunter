import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { computeRuntimeStateGuardedBatchWrite } from '../../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import {
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchEffect,
    type RuntimeStateGuardedBatchGuard
} from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from '../../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { decodeJsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { groupStateEventWorkspaceKey } from '../../../state-events/postgres/group-state-event-workspace-key.ts';
import { groupStateGroupStorageKey } from '../../persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    groupStateInsertGroupDescriptor,
    groupStateUpdateGroupDescriptor
} from '../../persistence/aggregate/group-aggregate-write-descriptors.ts';
import { decodeCurrentGroupLifecyclePolicy } from '../../persistence/decode-stored-group-lifecycle-policy.ts';
import { GROUP_LIFECYCLE_POLICIES_NAMESPACE } from '../../persistence/group-lifecycle-policy-repository.ts';
import { groupStateInsertIdempotencyDescriptor } from '../../persistence/idempotency/group-idempotency-write-descriptor.ts';
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
import type {
    GroupMutationDomainWrite,
    GroupMutationPersistence
} from '../group-mutation-contracts.ts';

export function computeGroupMutationPersistence(
    computed: GroupMutationDomainWrite
): GroupMutationPersistence {
    return {
        guardedBatch: computeRuntimeStateGuardedBatchWrite(
            computeGroupMutationGuardedBatch(computed)
        ),
        lifecyclePolicyWrite: computed.lifecyclePolicy === null
            ? null
            : {
                namespace: GROUP_LIFECYCLE_POLICIES_NAMESPACE,
                key: groupStateGroupStorageKey(computed.receipt.aggregateRef),
                value: encodeRuntimeStateJsonValue({
                    groupRef: computed.receipt.aggregateRef,
                    policy: decodeCurrentGroupLifecyclePolicy(
                        decodeJsonWireValue(computed.lifecyclePolicy, 'Group lifecycle policy')
                    )
                }),
                expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
            },
        eventWrite: {
            event: computed.event,
            workspaceKey: groupStateEventWorkspaceKey(computed.event.workspaceId),
            eventJson: JSON.stringify(computed.event)
        }
    };
}

function computeGroupMutationGuardedBatch(
    computed: GroupMutationDomainWrite
): RuntimeStateGuardedBatch {
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    effects.push(...computePresenceAndMembershipEffects(computed));
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
            ...groupStateInsertIdempotencyDescriptor({
                ref: computed.idempotency.aggregateRef,
                requestId: computed.idempotency.requestId,
                record: computed.idempotency,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            })
        });
    }
    return validateRuntimeStateGuardedBatch({
        guard: computeGroupMutationGuard(computed),
        effects
    });
}

function computeGroupMutationGuard(
    computed: GroupMutationDomainWrite
): RuntimeStateGuardedBatchGuard {
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

function computePresenceAndMembershipEffects(
    computed: GroupMutationDomainWrite
): RuntimeStateGuardedBatchEffect[] {
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
    return effects;
}

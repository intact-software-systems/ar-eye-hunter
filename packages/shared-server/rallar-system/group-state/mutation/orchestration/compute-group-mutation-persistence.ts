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
import { toPublicationGrantBatchEffect } from '../../persistence/publication/group-publication-grant-write-descriptors.ts';
import {
    groupStateDeleteTopicSubscriptionDescriptor,
    groupStateInsertTopicSubscriptionDescriptor,
    groupStateUpdateTopicSubscriptionDescriptor,
    toTopicSubscriptionDeleteBatchEffect
} from '../../persistence/subscription/group-topic-subscription-write-descriptors.ts';
import type {
    GroupMutationDomainWrite,
    GroupMutationFacts,
    GroupMutationPersistence,
    GroupMutationRead
} from '../group-mutation-contracts.ts';

export function computeGroupMutationPersistence(
    computed: GroupMutationDomainWrite,
    facts: Pick<GroupMutationFacts, 'expireAtEpochMs' | 'nowEpochMs'>,
    read: GroupMutationRead
): GroupMutationPersistence {
    return {
        guardedBatch: computeRuntimeStateGuardedBatchWrite(
            computeGroupMutationGuardedBatch(computed, facts, read)
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
                expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString(),
                updatedAtIsoTimestamp: new Date(facts.nowEpochMs).toISOString()
            },
        eventWrite: computed.event === null
            ? null
            : {
                event: computed.event,
                workspaceKey: groupStateEventWorkspaceKey(computed.event.workspaceId),
                eventJson: JSON.stringify(computed.event)
            }
    };
}

function computeGroupMutationGuardedBatch(
    computed: GroupMutationDomainWrite,
    facts: Pick<GroupMutationFacts, 'expireAtEpochMs'>,
    read: GroupMutationRead
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
    effects.push(...computed.publicationGrantEffects.map(toPublicationGrantBatchEffect));
    effects.push(...computed.subscriptionEffects.map(toTopicSubscriptionDeleteBatchEffect));
    if (computed.idempotency) {
        effects.push({
            effectId: 'receipt',
            ...groupStateInsertIdempotencyDescriptor({
                ref: computed.idempotency.aggregateRef,
                requestId: computed.idempotency.requestId,
                record: computed.idempotency,
                expireAtTimestamp: facts.expireAtEpochMs
            })
        });
    }
    const guard = computeGroupMutationGuard(computed);
    if (computed.guard.kind === 'presence' && computed.presenceAdmission?.operation === 'insert') {
        // Retirement deletes the member too, so this exact revision fences an admission that was
        // absent before archival without making unrelated members contend on the group row.
        const member = read.targetMemberEntry;
        if (member === null) {
            throw new TypeError('Initial presence admission requires its observed member');
        }
        effects.push({
            effectId: 'presence-member-fence',
            ...groupStateMemberPutDescriptor(member.value),
            operation: 'update',
            expectedRevision: member.entry.revision
        });
    }
    return validateRuntimeStateGuardedBatch({ guard, effects });
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
    if (guard.kind === 'subscription') {
        switch (guard.operation) {
            case 'insert':
                return groupStateInsertTopicSubscriptionDescriptor(guard.ref, guard.value);
            case 'update':
                return groupStateUpdateTopicSubscriptionDescriptor(guard.ref, guard.value, guard.expectedRevision);
            case 'delete':
                return groupStateDeleteTopicSubscriptionDescriptor(guard.ref, guard.value, guard.expectedRevision);
        }
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

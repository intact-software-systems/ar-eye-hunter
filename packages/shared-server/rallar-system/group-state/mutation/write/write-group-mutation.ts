import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '../../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchEffect,
    type RuntimeStateGuardedBatchGuard
} from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatchResult } from '../../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch-result.ts';
import { validateRuntimeStateGuardedBatch } from '../../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    createTransactionBoundPSqlRuntimeStateRepository,
    type PSqlRuntimeStateRepository
} from '../../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import {
    groupStateInsertGroupDescriptor,
    groupStateUpdateGroupDescriptor
} from '../../persistence/aggregate/group-aggregate-write-descriptors.ts';
import { GroupLifecyclePolicyRepository } from '../../persistence/group-lifecycle-policy-repository.ts';
import { createTransactionBoundGroupStateRepository } from '../../persistence/group-state-repository.ts';
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
import type { GroupMutationComputedWrite, GroupMutationReceipt } from '../group-mutation-contracts.ts';

export function materializeGroupStateGuardedBatch(
    computed: GroupMutationComputedWrite
): RuntimeStateGuardedBatch {
    const effects: RuntimeStateGuardedBatchEffect[] = [];

    effects.push(...materializePresenceAndMembershipEffects(computed));

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
        guard: materializeGuard(computed),
        effects
    });
}

export async function writeGroupMutation(
    transaction: PSqlSql,
    computed: GroupMutationComputedWrite
): Promise<GroupMutationReceipt> {
    const batch = materializeGroupStateGuardedBatch(computed);
    const runtime = createTransactionBoundPSqlRuntimeStateRepository(transaction);
    const repository = createTransactionBoundGroupStateRepository(transaction);

    await executeGuardedGroupMutationBatch(runtime, batch);

    if (computed.lifecyclePolicy !== null) {
        await new GroupLifecyclePolicyRepository(runtime).writePolicy(
            computed.receipt.aggregateRef,
            computed.lifecyclePolicy
        );
    }

    await repository.appendEvent(computed.event);
    const outbox = new PSqlResourceInboxEntryRepository(transaction);
    for (const entry of computed.outboxEntries) {
        await outbox.writeIfAbsentOrMatch(entry);
    }
    return computed.receipt;
}

async function executeGuardedGroupMutationBatch(
    runtime: PSqlRuntimeStateRepository,
    batch: RuntimeStateGuardedBatch
): Promise<void> {
    const result = validateRuntimeStateGuardedBatchResult(
        batch,
        await runtime.executeGuardedBatch(batch)
    );
    if (result.guard.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    for (const effect of result.effects) {
        if (effect.status !== 'applied') {
            throw new RuntimeStateWriteConflictError();
        }
    }
}

function materializeGuard(computed: GroupMutationComputedWrite): RuntimeStateGuardedBatchGuard {
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

function materializePresenceAndMembershipEffects(
    computed: GroupMutationComputedWrite
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

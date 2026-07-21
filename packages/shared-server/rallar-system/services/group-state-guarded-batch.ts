import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
  isRuntimeStateGuardedBatchRepositoryLike,
  type RuntimeStateGuardedBatch,
  type RuntimeStateGuardedBatchEffect,
  type RuntimeStateGuardedBatchGuard,
  validateRuntimeStateGuardedBatch,
  validateRuntimeStateGuardedBatchResult,
} from '../../runtime-state/RuntimeStateGuardedBatch.ts';
import type * as RuntimeStateRepositoryTypes from '../../runtime-state/RuntimeStateRepository.ts';
import {
  requireConditionalWrite,
  RuntimeStateWriteConflictError,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import {
  groupStateDeletePresenceDescriptor,
  groupStateInsertGroupDescriptor,
  groupStateInsertIdempotencyDescriptor,
  groupStateInsertPresenceAdmissionDescriptor,
  groupStateInsertPresenceDescriptor,
  groupStateInsertPresenceSummaryDescriptor,
  groupStateMemberPutDescriptor,
  groupStateUpdateGroupDescriptor,
  groupStateUpdatePresenceAdmissionDescriptor,
  groupStateUpdatePresenceDescriptor,
} from '../repositories/group-state-write-descriptors.ts';
import {
  createStateMutationOutboxRecord,
  STATE_MUTATION_OUTBOX_NAMESPACE,
  type StateMutationOutboxRecord,
  StateMutationOutboxCollisionError,
  StateMutationOutboxRepository,
  stateMutationOutboxStorageKey,
} from '../repositories/StateMutationOutboxRepository.ts';
import type { GroupMutationComputed, GroupMutationReceipt } from './group-state-mutations.ts';

type GroupWrite = Extract<GroupMutationComputed, { outcome: 'write' }>;
type RuntimeStateRepository =
  RuntimeStateRepositoryTypes.RuntimeStateOptimisticTransactionalRepositoryLike;

export interface MaterializedGroupStateGuardedBatch {
  readonly batch: RuntimeStateGuardedBatch;
  readonly outbox: StateMutationOutboxRecord;
}

export function materializeGroupStateGuardedBatch(
  computed: GroupWrite,
): MaterializedGroupStateGuardedBatch {
  const effects: RuntimeStateGuardedBatchEffect[] = [];

  if (computed.presenceAdmission) {
    const admission = computed.presenceAdmission;
    effects.push({
      effectId: 'presence-admission',
      ...(admission.operation === 'insert'
        ? groupStateInsertPresenceAdmissionDescriptor(admission.value)
        : groupStateUpdatePresenceAdmissionDescriptor(admission.value, admission.expectedRevision)),
    });
  }

  for (const member of computed.members) {
    effects.push({
      effectId: `member:${member.principalId}`,
      ...groupStateMemberPutDescriptor(member),
    });
  }

  if (computed.initialPresenceSummary) {
    effects.push({
      effectId: 'initial-presence-summary',
      ...groupStateInsertPresenceSummaryDescriptor(computed.initialPresenceSummary),
    });
  }

  if (computed.idempotency) {
    effects.push({
      effectId: 'receipt',
      ...groupStateInsertIdempotencyDescriptor({
        ref: computed.idempotency.aggregateRef,
        requestId: computed.idempotency.requestId,
        record: computed.idempotency,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
      }),
    });
  }

  const outbox = createStateMutationOutboxRecord(computed.outbox);
  effects.push({
    effectId: 'outbox',
    operation: 'insert',
    namespace: STATE_MUTATION_OUTBOX_NAMESPACE,
    key: stateMutationOutboxStorageKey(outbox.outboxId),
    value: serializeBatchValue(outbox),
    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
  });

  return {
    batch: validateRuntimeStateGuardedBatch({
      guard: materializeGuard(computed),
      effects,
    }),
    outbox,
  };
}

export async function writeGroupMutation(
  runtime: RuntimeStateRepository,
  repositoryFor: (target: RuntimeStateRepository) => GroupStateRepository,
  computed: GroupWrite,
): Promise<GroupMutationReceipt> {
  const materialized = materializeGroupStateGuardedBatch(computed);
  return await runtime.begin(async (transaction) => {
    const repository = repositoryFor(transaction);

    if (isRuntimeStateGuardedBatchRepositoryLike(transaction)) {
      const result = validateRuntimeStateGuardedBatchResult(
        materialized.batch,
        await transaction.executeGuardedBatch(materialized.batch),
      );
      if (result.guard.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
      }
      for (const effect of result.effects) {
        if (effect.status === 'applied') {
          continue;
        }
        if (effect.effectId === 'outbox') {
          throw new StateMutationOutboxCollisionError(materialized.outbox.outboxId);
        }
        throw new RuntimeStateWriteConflictError();
      }
      await repository.appendEvent(computed.event);
      return computed.receipt;
    }

    // Aggregate/session ownership is always the first database statement.
    if (computed.guard.kind === 'group') {
      requireConditionalWrite(
        computed.guard.operation === 'insert'
          ? await repository.insertGroup(computed.guard.value)
          : await repository.updateGroup(computed.guard.value, computed.guard.expectedRevision),
      );
    } else {
      requireConditionalWrite(
        computed.guard.operation === 'insert'
          ? await repository.insertPresence(computed.guard.value)
          : computed.guard.operation === 'update'
            ? await repository.updatePresence(computed.guard.value, computed.guard.expectedRevision)
            : await repository.deletePresence(
                computed.guard.value,
                computed.guard.expectedRevision,
              ),
      );
    }

    if (computed.presenceAdmission) {
      requireConditionalWrite(
        computed.presenceAdmission.operation === 'insert'
          ? await repository.insertPresenceAdmission(computed.presenceAdmission.value)
          : await repository.updatePresenceAdmission(
              computed.presenceAdmission.value,
              computed.presenceAdmission.expectedRevision,
            ),
      );
    }

    for (const member of computed.members) {
      await repository.putMember(member);
    }
    if (computed.initialPresenceSummary) {
      requireConditionalWrite(
        await repository.insertPresenceSummary(computed.initialPresenceSummary),
      );
    }
    if (computed.idempotency) {
      requireConditionalWrite(
        await repository.insertIdempotentGroupMutationReceipt(
          computed.outbox.aggregateRef,
          computed.idempotency.requestId,
          computed.idempotency,
        ),
      );
    }
    await new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite(
      materialized.outbox,
    );
    await repository.appendEvent(computed.event);
    return computed.receipt;
  });
}

function materializeGuard(computed: GroupWrite): RuntimeStateGuardedBatchGuard {
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

function serializeBatchValue(value: StateMutationOutboxRecord): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new TypeError('Group state batch value is not JSON serializable');
  }
  return serialized;
}

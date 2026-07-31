import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
  isRuntimeStateGuardedBatchRepositoryLike,
  type RuntimeStateGuardedBatch,
  type RuntimeStateGuardedBatchEffect,
  type RuntimeStateGuardedBatchGuard,
  validateRuntimeStateGuardedBatch,
  validateRuntimeStateGuardedBatchResult,
} from '../../runtime-state/RuntimeStateGuardedBatch.ts';
import {
  requireConditionalWrite,
  RuntimeStateWriteConflictError,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
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
  groupStateUpdatePresenceSummaryDescriptor,
} from '../repositories/group-state-write-descriptors.ts';
import {
  createTransactionBoundGroupStateRepository,
} from '../repositories/GroupStateRepository.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import type {
  GroupMutationComputedWrite,
  GroupMutationReceipt,
} from '../group-state/mutation/group-mutation-contracts.ts';

export interface MaterializedGroupStateGuardedBatch {
  readonly batch: RuntimeStateGuardedBatch;
}

export function materializeGroupStateGuardedBatch(
  computed: GroupMutationComputedWrite,
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
    const summary = computed.initialPresenceSummary;
    effects.push({
      effectId: 'initial-presence-summary',
      ...(summary.operation === 'insert'
        ? groupStateInsertPresenceSummaryDescriptor(summary.value)
        : groupStateUpdatePresenceSummaryDescriptor(summary.value, summary.expectedRevision)),
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

  return {
    batch: validateRuntimeStateGuardedBatch({
      guard: materializeGuard(computed),
      effects,
    }),
  };
}

export async function writeGroupMutation(
  transaction: PSqlTransactionSql,
  computed: GroupMutationComputedWrite,
): Promise<GroupMutationReceipt> {
  const materialized = materializeGroupStateGuardedBatch(computed);
  const runtime = new PSqlRuntimeStateRepository(transaction);
  const repository = createTransactionBoundGroupStateRepository(transaction);

  if (isRuntimeStateGuardedBatchRepositoryLike(runtime)) {
      const result = validateRuntimeStateGuardedBatchResult(
        materialized.batch,
        await runtime.executeGuardedBatch(materialized.batch),
      );
      if (result.guard.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
      }
      for (const effect of result.effects) {
        if (effect.status === 'applied') {
          continue;
        }
        throw new RuntimeStateWriteConflictError();
      }
  } else {
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
        const summary = computed.initialPresenceSummary;
        requireConditionalWrite(
          summary.operation === 'insert'
            ? await repository.insertPresenceSummary(summary.value)
            : await repository.updatePresenceSummary(
                summary.value,
                summary.expectedRevision,
              ),
        );
      }
      if (computed.idempotency) {
        requireConditionalWrite(
          await repository.insertIdempotentGroupMutationReceipt(
            computed.receipt.aggregateRef,
            computed.idempotency.requestId,
            computed.idempotency,
          ),
        );
      }
  }

  await repository.appendEvent(computed.event);
  const outbox = new ResourceInboxRepository(transaction);
  for (const entry of computed.outboxEntries) {
    await outbox.writeIfAbsentOrMatch(entry);
  }
  return computed.receipt;
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

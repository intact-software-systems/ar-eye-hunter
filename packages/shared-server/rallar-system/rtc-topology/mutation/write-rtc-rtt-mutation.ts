import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';

import { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '../persistence/rtc-rtt-persistence-validation.ts';
import { validateRtcRttWriteCandidate } from './validate-rtc-rtt-write-candidate.ts';
import { writeRtcTopologyOutbox } from '../../services/rtc-topology-outbox-entry.ts';
import type { RtcRttMutationComputed } from './rtc-rtt-mutation-contracts.ts';

export async function writeRtcRttMutation(
  transaction: PSqlTransactionSql,
  options: ConstructorParameters<typeof RtcRttRepository>[1],
  computed: Extract<RtcRttMutationComputed, { outcome: 'write' }>,
): Promise<'accepted'> {
  const mutationExpireAtTimestamp =
    computed.receipt.acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
  validateRtcRttWriteCandidate(computed, mutationExpireAtTimestamp);
  const runtime = new PSqlRuntimeStateRepository(transaction);
  const repository = new RtcRttRepository(runtime, options);
  for (const guard of computed.endpointGuards) {
    requireAcceptedRttWrite(
      await repository.commitEndpointAdmission(
        guard.value,
        guard.expectedRevision,
        guard.expireAtTimestamp,
      ),
    );
  }
  requireAcceptedRttWrite(
    await repository.commitMeasurement(
      computed.measurementGuard.value,
      computed.measurementGuard.expectedRevision,
      computed.measurementGuard.purgeAfterEpochMs,
    ),
  );
  requireAcceptedRttWrite(
    await repository.insertMutationReceipt(computed.receipt, mutationExpireAtTimestamp),
  );
  for (let index = 0; index < computed.affectedGroups.length; index += 1) {
    const group = computed.affectedGroups[index]!;
    await writeRtcTopologyOutbox(transaction, {
      commandId: computed.receipt.receiptId,
      resourceId: computed.receipt.outboxIds[index]!,
      aggregateRef: group.group,
      acceptedCausalRevision: group.causalRevision,
      groupSnapshot: group,
      effectKind: 'rtc-topology-recompute',
      payloadKind: 'rtt-refresh',
      rtt: computed.measurementGuard.value,
      refinementObservationId: computed.receipt.receiptId,
      createdAtEpochMs: computed.receipt.acceptedAtEpochMs,
      expireAtEpochMs: mutationExpireAtTimestamp,
      senderId: computed.senderId,
      requestOptions: toCanonicalGroupTopologyConfigPatch({}),
      publish: true,
    });
  }
  return 'accepted';
}

function requireAcceptedRttWrite(result: Readonly<{ status: 'accepted' | 'conflict' }>): void {
  if (result.status === 'conflict') {
    throw new RuntimeStateWriteConflictError();
  }
}

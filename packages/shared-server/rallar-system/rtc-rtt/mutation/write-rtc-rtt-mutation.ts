import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';

import type { RtcTopologyOutboxWriter } from '../../topology/mutation/rtc-topology-outbox-writer.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '../persistence/rtc-rtt-persistence-validation-primitives.ts';
import { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';
import type { RtcRttMutationComputed } from './rtc-rtt-mutation-contracts.ts';
import { validateRtcRttWriteCandidate } from './validate-rtc-rtt-write-candidate.ts';

export interface WriteRtcRttMutationInput {
    readonly transaction: PSqlSql;
    readonly repositoryOptions: ConstructorParameters<typeof RtcRttRepository>[1];
    readonly computed: Extract<RtcRttMutationComputed, { outcome: 'write'; }>;
    readonly outboxWriter: RtcTopologyOutboxWriter;
}

export async function writeRtcRttMutation(input: WriteRtcRttMutationInput): Promise<'accepted'> {
    const { transaction, computed } = input;
    const mutationExpireAtTimestamp = computed.receipt.acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
    validateRtcRttWriteCandidate(computed, mutationExpireAtTimestamp);
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const repository = new RtcRttRepository(runtime, input.repositoryOptions);
    for (const guard of computed.endpointGuards) {
        requireAcceptedRttWrite(
            await repository.commitEndpointAdmission(
                guard.value,
                guard.expectedRevision,
                guard.expireAtTimestamp
            )
        );
    }
    requireAcceptedRttWrite(
        await repository.commitMeasurement(
            computed.measurementGuard.value,
            computed.measurementGuard.expectedRevision,
            computed.measurementGuard.purgeAfterEpochMs
        )
    );
    requireAcceptedRttWrite(
        await repository.insertMutationReceipt(computed.receipt, mutationExpireAtTimestamp)
    );
    for (const outboxWrite of computed.outboxWrites) {
        await input.outboxWriter.write(transaction, outboxWrite);
    }
    return 'accepted';
}

function requireAcceptedRttWrite(result: Readonly<{ status: 'accepted' | 'conflict'; }>): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}

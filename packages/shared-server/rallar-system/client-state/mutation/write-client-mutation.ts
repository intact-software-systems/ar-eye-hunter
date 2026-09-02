import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { requireConditionalWrite } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { writeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type { ClientMutationReceipt } from '../persistence/client-state-persistence-contracts.ts';
import { ClientStateRepository } from '../persistence/client-state-repository.ts';
import type { ClientMutationComputedWrite } from './client-mutation-contracts.ts';

export async function writeClientMutation(
    transaction: PSqlSql,
    repository: ClientStateRepository,
    computed: ClientMutationComputedWrite
): Promise<ClientMutationReceipt> {
    if (computed.outcome === 'no-op') {
        await writeIdempotencyRecord(repository, computed.aggregateRef, computed.idempotency);
        return computed.receipt;
    }

    await writePrincipalCandidate(repository, computed);
    await writeInstanceCandidate(repository, computed.instance);
    await writeSessionCandidate(repository, computed.session);
    if (computed.idempotency) {
        await writeIdempotencyRecord(repository, computed.receipt.aggregateRef, computed.idempotency);
    }

    await repository.appendEvent(computed.event);
    for (const outbox of computed.outboxWrites) {
        await writeAppOutboxInsert(transaction, outbox);
    }
    return computed.receipt;
}

async function writePrincipalCandidate(
    repository: ClientStateRepository,
    computed: Extract<ClientMutationComputedWrite, { outcome: 'write'; }>
): Promise<void> {
    requireConditionalWrite(
        computed.principal.operation === 'insert'
            ? await repository.insertPrincipal(computed.principal.value)
            : await repository.updatePrincipal(
                computed.principal.value,
                computed.principal.expectedRevision
            )
    );
}

async function writeInstanceCandidate(
    repository: ClientStateRepository,
    candidate: Extract<ClientMutationComputedWrite, { outcome: 'write'; }>['instance']
): Promise<void> {
    if (candidate.operation === 'none') {
        return;
    }
    requireConditionalWrite(
        candidate.operation === 'insert'
            ? await repository.insertInstance(candidate.value)
            : await repository.updateInstance(candidate.value, candidate.expectedRevision)
    );
}

async function writeSessionCandidate(
    repository: ClientStateRepository,
    candidate: Extract<ClientMutationComputedWrite, { outcome: 'write'; }>['session']
): Promise<void> {
    if (candidate.operation === 'none') {
        return;
    }
    requireConditionalWrite(
        candidate.operation === 'insert'
            ? await repository.insertSession(candidate.value)
            : await repository.updateSession(candidate.value, candidate.expectedRevision)
    );
}

async function writeIdempotencyRecord(
    repository: ClientStateRepository,
    aggregateRef: ClientMutationComputedWrite['receipt']['aggregateRef'],
    idempotency: NonNullable<Extract<ClientMutationComputedWrite, { outcome: 'no-op'; }>['idempotency']>
): Promise<void> {
    requireConditionalWrite(
        await repository.insertIdempotentClientStateWritten(
            aggregateRef,
            idempotency.requestId,
            idempotency
        )
    );
}

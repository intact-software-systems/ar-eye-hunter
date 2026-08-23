import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository, type PSqlResourceInboxRepository } from '../../../../queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { requireConditionalWrite } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { ClientStateRepository } from '../../persistence/client-state-repository.ts';
import type { ClientMutationComputedWrite, ClientMutationReceipt } from '../client-mutation-contracts.ts';

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
    await writeChildCandidate(repository, computed.instance, 'instance');
    await writeChildCandidate(repository, computed.session, 'session');
    if (computed.idempotency) {
        await writeIdempotencyRecord(repository, computed.receipt.aggregateRef, computed.idempotency);
    }

    await repository.appendEvent(computed.event);
    await writeFinalOutboxEntries(transaction, computed);
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

async function writeChildCandidate(
    repository: ClientStateRepository,
    candidate:
        | Extract<ClientMutationComputedWrite, { outcome: 'write'; }>['instance']
        | Extract<ClientMutationComputedWrite, { outcome: 'write'; }>['session'],
    kind: 'instance' | 'session'
): Promise<void> {
    if (candidate.operation === 'none') {
        return;
    }
    if (kind === 'instance') {
        const value = candidate.value as Parameters<ClientStateRepository['insertInstance']>[0];
        requireConditionalWrite(
            candidate.operation === 'insert'
                ? await repository.insertInstance(value)
                : await repository.updateInstance(value, candidate.expectedRevision)
        );
        return;
    }
    const value = candidate.value as Parameters<ClientStateRepository['insertSession']>[0];
    requireConditionalWrite(
        candidate.operation === 'insert'
            ? await repository.insertSession(value)
            : await repository.updateSession(value, candidate.expectedRevision)
    );
}

async function writeFinalOutboxEntries(
    transaction: PSqlSql,
    computed: Extract<ClientMutationComputedWrite, { outcome: 'write'; }>
): Promise<void> {
    const outbox = createPSqlResourceInboxRepository(transaction);
    for (const entry of computed.outboxEntries) {
        await outbox.entries.writeIfAbsentOrMatch(entry);
    }
}

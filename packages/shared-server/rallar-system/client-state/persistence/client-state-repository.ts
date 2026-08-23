import type {
    ClientEvent,
    ClientInstance,
    ClientInstanceRef,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientSession,
    ClientSessionRef
} from '@shared/api/client-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import { toSessionPurgeAfterEpochMs } from '../../presence/session-expiry.ts';
import type { ClientStateEventStore } from '../../state-events/client-state-event-store.ts';
import { PSqlClientStateEventRepository } from '../../state-events/postgres/p-sql-client-state-event-repository.ts';
import { type ClientMutationIdempotencyRecord } from './client-state-persistence-contracts.ts';
import { assertCanonicalClientStateIdempotencyRecord } from './client-state-repository-reads.ts';
import {
    CLIENT_STATE_IDEMPOTENT_NAMESPACE,
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from './client-state-runtime-namespaces.ts';
import { ClientStateSnapshotRepository } from './client-state-snapshot-repository.ts';
import {
    clientStateIdempotencyStorageKey,
    clientStateInstanceStorageKey,
    clientStatePrincipalStorageKey,
    clientStateSessionStorageKey
} from './client-state-storage-keys.ts';
import {
    validatePersistedClientEvent,
    validatePersistedClientInstance,
    validatePersistedClientPrincipal,
    validatePersistedClientSession
} from './validate-persisted-client-state.ts';

export type {
    ClientMutationIdempotencyRecord,
    ClientPrincipalSnapshotRead
} from './client-state-persistence-contracts.ts';
export { ClientStateRepositoryInvariantCorruptionError } from './client-state-persistence-contracts.ts';

export function createTransactionBoundClientStateRepository(
    transaction: PSqlSql
): ClientStateRepository {
    const runtime = new PSqlRuntimeStateRepository(transaction);
    return new ClientStateRepository(runtime, new PSqlClientStateEventRepository(transaction));
}

export class ClientStateRepository extends ClientStateSnapshotRepository {
    constructor(repository: RuntimeStateRepositoryLike, events: ClientStateEventStore) {
        super(repository, events);
    }

    async insertIdempotentClientStateWritten(
        ref: ClientPrincipalRef,
        requestId: string,
        record: ClientMutationIdempotencyRecord,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP
    ): Promise<RuntimeStateConditionalWriteResult> {
        assertCanonicalClientStateIdempotencyRecord(record, ref, requestId);
        return await this.putValueIfAbsent(
            CLIENT_STATE_IDEMPOTENT_NAMESPACE,
            clientStateIdempotencyStorageKey(ref, requestId),
            record,
            purgeAfterEpochMs
        );
    }

    async insertPrincipal(principal: ClientPrincipal): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientPrincipal(principal, principal);
        return await this.putValueIfAbsent(
            CLIENT_STATE_PRINCIPALS_NAMESPACE,
            clientStatePrincipalStorageKey(principal),
            principal
        );
    }

    async updatePrincipal(
        principal: ClientPrincipal,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientPrincipal(principal, principal);
        return await this.putValueIfRevision(
            CLIENT_STATE_PRINCIPALS_NAMESPACE,
            clientStatePrincipalStorageKey(principal),
            principal,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision
        );
    }

    async deletePrincipal(
        ref: ClientPrincipalRef,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            CLIENT_STATE_PRINCIPALS_NAMESPACE,
            clientStatePrincipalStorageKey(ref),
            expectedRevision
        );
    }

    async insertInstance(instance: ClientInstance): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientInstance(instance, instance);
        return await this.putValueIfAbsent(
            CLIENT_STATE_INSTANCES_NAMESPACE,
            clientStateInstanceStorageKey(instance),
            instance
        );
    }

    async updateInstance(
        instance: ClientInstance,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientInstance(instance, instance);
        return await this.putValueIfRevision(
            CLIENT_STATE_INSTANCES_NAMESPACE,
            clientStateInstanceStorageKey(instance),
            instance,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision
        );
    }

    async deleteInstance(
        ref: ClientInstanceRef,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            CLIENT_STATE_INSTANCES_NAMESPACE,
            clientStateInstanceStorageKey(ref),
            expectedRevision
        );
    }

    async insertSession(session: ClientSession): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientSession(session, session);
        return await this.putValueIfAbsent(
            CLIENT_STATE_SESSIONS_NAMESPACE,
            clientStateSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs)
        );
    }

    async updateSession(
        session: ClientSession,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientSession(session, session);
        return await this.putValueIfRevision(
            CLIENT_STATE_SESSIONS_NAMESPACE,
            clientStateSessionStorageKey(session),
            session,
            toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs),
            expectedRevision
        );
    }

    async deleteSession(
        ref: ClientSessionRef,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            CLIENT_STATE_SESSIONS_NAMESPACE,
            clientStateSessionStorageKey(ref),
            expectedRevision
        );
    }

    async appendEvent(event: ClientEvent): Promise<void> {
        validatePersistedClientEvent(event, event);
        await this.events.appendClientEvent(event);
    }
}

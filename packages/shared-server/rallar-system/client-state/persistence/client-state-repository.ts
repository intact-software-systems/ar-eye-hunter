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

import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import { toSessionPurgeAfterEpochMs } from '../../presence/session-expiry.ts';
import type { ClientStateEventStore } from '../../state-events/client-state-event-store.ts';
import { clientStateInstanceStorageKey } from './client-state-instance-storage-key.ts';
import { clientStatePrincipalStorageKey } from './client-state-principal-storage-key.ts';
import {
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from './client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from './client-state-session-storage-key.ts';
import { ClientStateSnapshotRepository } from './client-state-snapshot-repository.ts';
import {
    validatePersistedClientEvent,
    validatePersistedClientInstance,
    validatePersistedClientPrincipal,
    validatePersistedClientSession
} from './validate-persisted-client-state.ts';

export class ClientStateRepository extends ClientStateSnapshotRepository {
    constructor(repository: RuntimeStateRepositoryLike, events: ClientStateEventStore) {
        super(repository, events);
    }

    async insertPrincipal(principal: ClientPrincipal): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientPrincipal(principal, principal);
        return await this.putValueIfAbsent(
            {
                namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE,
                key: clientStatePrincipalStorageKey(principal),
                value: principal,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
    }

    async updatePrincipal(
        principal: ClientPrincipal,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientPrincipal(principal, principal);
        return await this.putValueIfRevision(
            {
                namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE,
                key: clientStatePrincipalStorageKey(principal),
                value: principal,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision
            }
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
            {
                namespace: CLIENT_STATE_INSTANCES_NAMESPACE,
                key: clientStateInstanceStorageKey(instance),
                value: instance,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
    }

    async updateInstance(
        instance: ClientInstance,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientInstance(instance, instance);
        return await this.putValueIfRevision(
            {
                namespace: CLIENT_STATE_INSTANCES_NAMESPACE,
                key: clientStateInstanceStorageKey(instance),
                value: instance,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision
            }
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
            {
                namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
                key: clientStateSessionStorageKey(session),
                value: session,
                expireAtTimestamp: toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs)
            }
        );
    }

    async updateSession(
        session: ClientSession,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientSession(session, session);
        return await this.putValueIfRevision(
            {
                namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
                key: clientStateSessionStorageKey(session),
                value: session,
                expireAtTimestamp: toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs),
                expectedRevision
            }
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

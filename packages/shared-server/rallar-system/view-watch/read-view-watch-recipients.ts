import { jsonEquals } from '@shared/repository/state-utils.ts';
import { readRuntimeStateKeySelections } from '../../runtime-state/read-batch/read-runtime-state-key-selections.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE, authSessionKey } from '../auth/persistence/auth-storage-keys.ts';
import { decodePersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import { decodePersistedClientSession } from '../client-state/persistence/client-state-persistence-codec.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '../client-state/persistence/client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from '../client-state/persistence/client-state-session-storage-key.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    decodeViewWatchEntry,
    VIEW_WATCH_SLOTS_NAMESPACE,
    ViewWatchRepository,
    viewWatchSlotKey,
    type ViewWatchRegistration,
    type ViewWatchResource
} from './view-watch-repository.ts';

interface ViewWatchRecipientRead {
    readonly repository: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>;
    readonly registration: ViewWatchRegistration;
    readonly nowEpochMs: number;
}

/** Reads only the resource's registrations and their exact session/slot keys; no client or scope scan. */
export async function readViewWatchRecipients(
    repository: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>,
    ref: ViewWatchResource,
    nowEpochMs: number
): Promise<readonly string[]> {
    const registrations = await new ViewWatchRepository(repository).listForResource(ref);
    const current = await Promise.all(
        registrations.map(({ value }) => readIsCurrentWatch({ repository, registration: value, nowEpochMs }))
    );
    return registrations.filter((_, index) => current[index]).map(({ value }) => value.principalId);
}

async function readIsCurrentWatch({ repository, registration, nowEpochMs }: ViewWatchRecipientRead): Promise<boolean> {
    if (registration.expiresAtEpochMs <= nowEpochMs) {
        return false;
    }
    const [auth, client, slot] = await readRuntimeStateKeySelections(repository, [
        {
            selectorId: 'auth',
            kind: 'key',
            namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            key: authSessionKey(registration.sessionId)
        },
        {
            selectorId: 'client',
            kind: 'key',
            namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
            key: clientStateSessionStorageKey(registration)
        },
        { selectorId: 'slot', kind: 'key', namespace: VIEW_WATCH_SLOTS_NAMESPACE, key: viewWatchSlotKey(registration) }
    ]);
    if (auth === undefined || client === undefined || slot === undefined) {
        return false;
    }
    const session = decodePersistedAuthSession(decodeJsonWireValue(JSON.parse(auth.value), 'Watch auth session'));
    const connection = decodePersistedClientSession(JSON.parse(client.value), registration);
    const own = decodeViewWatchEntry(slot, 'slot');
    return jsonEquals(own.value, registration) && session.clientId === registration.principalId &&
        session.sessionId === registration.sessionId &&
        session.issuedAtEpochMs === registration.sessionIssuedAtEpochMs &&
        session.expiresAtEpochMs === registration.expiresAtEpochMs && session.expiresAtEpochMs > nowEpochMs &&
        connection.status === 'active' && connection.expiresAtEpochMs > nowEpochMs && connection.transport === 'ws' &&
        connection.generationId === registration.connectionGenerationId &&
        connection.connectionId === registration.connectionGenerationId;
}

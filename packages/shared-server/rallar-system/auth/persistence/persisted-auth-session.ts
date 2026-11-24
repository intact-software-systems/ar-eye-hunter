import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    assertExactAuthPersistenceKeys,
    decodeAuthPersistenceObject,
    decodeAuthPersistenceString,
    decodeAuthPersistenceTimestamp
} from './auth-persistence-value-decoding.ts';

export type PersistedAuthSession = JsonWireObject & Readonly<{
    guestRoom?: GroupRef;
    readonly clientId: string;
    readonly username: string;
    readonly sessionId: string;
    readonly accessTokenDigest: string;
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}>;

export function decodePersistedAuthSession(
    input: JsonWireValue
): PersistedAuthSession {
    const session = decodeAuthPersistenceObject(
        decodeJsonWireValue(input, 'Persisted auth session'),
        'Persisted auth session'
    );
    assertExactAuthPersistenceKeys(
        session,
        [
            'clientId',
            'username',
            'sessionId',
            'accessTokenDigest',
            'issuedAtEpochMs',
            'expiresAtEpochMs',
            ...(session.guestRoom === undefined ? [] : ['guestRoom'])
        ],
        'Persisted auth session'
    );
    const lifecycle = decodeAuthPersistenceLifecycle(session, 'Persisted auth session');
    const guestRoom = session.guestRoom === undefined ? undefined : decodeExactGroupRef(session.guestRoom, 'Guest transport');
    if (guestRoom && (typeof session.clientId !== 'string' || !/^guest-[0-9a-f]{64}$/u.test(session.clientId) ||
        typeof session.sessionId !== 'string' || !/^guest-session-[0-9a-f]{64}$/u.test(session.sessionId))) {
        throw new TypeError('Persisted guest transport identity is invalid.');
    }
    return {
        ...(guestRoom && { guestRoom }),
        clientId: decodeAuthPersistenceString(session.clientId, 'Persisted auth session clientId'),
        username: decodeAuthPersistenceString(session.username, 'Persisted auth session username'),
        sessionId: decodeAuthPersistenceString(session.sessionId, 'Persisted auth session sessionId'),
        accessTokenDigest: decodeAuthPersistenceString(
            session.accessTokenDigest,
            'Persisted auth session accessTokenDigest'
        ),
        issuedAtEpochMs: lifecycle.issuedAtEpochMs,
        expiresAtEpochMs: lifecycle.expiresAtEpochMs
    };
}

export interface AuthPersistenceLifecycle {
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export function decodeAuthPersistenceLifecycle(
    value: JsonWireObject,
    label: string
): AuthPersistenceLifecycle {
    const issuedAtEpochMs = decodeAuthPersistenceTimestamp(
        value.issuedAtEpochMs,
        `${label} issuedAtEpochMs`
    );
    const expiresAtEpochMs = decodeAuthPersistenceTimestamp(
        value.expiresAtEpochMs,
        `${label} expiresAtEpochMs`
    );
    if (issuedAtEpochMs >= expiresAtEpochMs) {
        throw new TypeError(`${label} lifecycle is invalid`);
    }
    return { issuedAtEpochMs, expiresAtEpochMs };
}

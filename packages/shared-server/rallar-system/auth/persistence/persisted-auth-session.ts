import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    assertExactAuthPersistenceKeys,
    decodeAuthPersistenceObject,
    decodeAuthPersistenceString,
    decodeAuthPersistenceTimestamp
} from './auth-persistence-value-decoding.ts';

export interface PersistedAuthSession extends JsonWireObject {
    readonly clientId: string;
    readonly username: string;
    readonly sessionId: string;
    readonly accessTokenDigest: string;
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

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
            'expiresAtEpochMs'
        ],
        'Persisted auth session'
    );
    const lifecycle = decodeAuthPersistenceLifecycle(session, 'Persisted auth session');
    return {
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

import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { normalizeAuthUsername } from '../credentials/normalize-auth-username.ts';
import {
    assertExactAuthPersistenceKeys,
    decodeAuthPersistenceObject,
    decodeAuthPersistenceString,
    decodeAuthPersistenceStringList,
    decodeAuthPersistenceTimestamp,
    decodePositiveAuthPersistenceInteger
} from './auth-persistence-value-decoding.ts';

export type AuthUserStatus = 'active' | 'disabled';

export interface PersistedAuthUser extends JsonWireObject {
    readonly clientId: string;
    readonly username: string;
    readonly normalizedUsername: string;
    readonly displayName: string | null;
    readonly passwordHash: string;
    readonly passwordSalt: string;
    readonly passwordAlgorithm: 'pbkdf2-sha256';
    readonly passwordIterations: number;
    readonly roles: readonly string[];
    readonly status: AuthUserStatus;
    readonly createdAtEpochMs: number;
    readonly updatedAtEpochMs: number;
}

export function decodePersistedAuthUser(
    input: JsonWireValue
): PersistedAuthUser {
    const user = decodeAuthPersistenceObject(
        decodeJsonWireValue(input, 'Persisted auth user'),
        'Persisted auth user'
    );
    assertExactAuthPersistenceKeys(
        user,
        [
            'clientId',
            'username',
            'normalizedUsername',
            'displayName',
            'passwordHash',
            'passwordSalt',
            'passwordAlgorithm',
            'passwordIterations',
            'roles',
            'status',
            'createdAtEpochMs',
            'updatedAtEpochMs'
        ],
        'Persisted auth user'
    );
    const clientId = decodeAuthPersistenceString(user.clientId, 'Persisted auth user clientId');
    const username = decodeAuthPersistenceString(user.username, 'Persisted auth user username');
    const normalizedUsername = decodeAuthPersistenceString(
        user.normalizedUsername,
        'Persisted auth user normalizedUsername'
    );
    const passwordHash = decodeAuthPersistenceString(
        user.passwordHash,
        'Persisted auth user passwordHash'
    );
    const passwordSalt = decodeAuthPersistenceString(
        user.passwordSalt,
        'Persisted auth user passwordSalt'
    );
    if (normalizedUsername !== normalizeAuthUsername(username)) {
        throw new TypeError('Persisted auth user normalized username is invalid');
    }
    const displayName = user.displayName === null
        ? null
        : decodeAuthPersistenceString(user.displayName, 'Persisted auth user displayName');
    if (user.passwordAlgorithm !== 'pbkdf2-sha256') {
        throw new TypeError('Persisted auth user password algorithm is invalid');
    }
    const passwordIterations = decodePositiveAuthPersistenceInteger(
        user.passwordIterations,
        'Persisted auth user password iterations'
    );
    const roles = decodeAuthPersistenceStringList(user.roles, 'Persisted auth user roles');
    if (user.status !== 'active' && user.status !== 'disabled') {
        throw new TypeError('Persisted auth user status is invalid');
    }
    const createdAtEpochMs = decodeAuthPersistenceTimestamp(
        user.createdAtEpochMs,
        'Persisted auth user created timestamp'
    );
    const updatedAtEpochMs = decodeAuthPersistenceTimestamp(
        user.updatedAtEpochMs,
        'Persisted auth user updated timestamp'
    );
    return {
        clientId,
        username,
        normalizedUsername,
        displayName,
        passwordHash,
        passwordSalt,
        passwordAlgorithm: user.passwordAlgorithm,
        passwordIterations,
        roles,
        status: user.status,
        createdAtEpochMs,
        updatedAtEpochMs
    };
}

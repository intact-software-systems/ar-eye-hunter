import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import {
    authClientIdKey,
    authNormalizedUsernameKey
} from '../../persistence/auth-storage-keys.ts';
import { decodePersistedAuthUser, type PersistedAuthUser } from '../../persistence/persisted-auth-user.ts';
import type {
    AuthComputedUserRegistration,
    AuthMutationComputed,
    AuthMutationRead,
    RegisterAuthUserCommand
} from '../auth-mutation-contracts.ts';
import { equalAuthJson } from '../validate/auth-mutation-validation.ts';

type RegisterAuthUserRead = Extract<AuthMutationRead, { kind: 'register-user'; }>;

export function computeAuthUserRegistration(
    command: RegisterAuthUserCommand,
    read: RegisterAuthUserRead
): AuthMutationComputed {
    return {
        kind: 'register-user',
        command,
        read,
        sessions: [],
        agentTickets: [],
        logoutDeletion: null,
        logoutOutbox: null,
        ticketDeletion: null,
        ticketWrites: [],
        userRegistration: computeAuthUserRegistrationWrite(command.user),
        result: {
            requestId: command.requestId,
            clientId: command.user.clientId,
            username: command.user.username,
            displayName: command.user.displayName,
            registeredAtEpochMs: command.user.createdAtEpochMs
        },
        outcome: isMatchingUserRead(read, command.user) ? 'replay' : 'write'
    };
}

export function computeAuthUserRegistrationWrite(user: PersistedAuthUser): AuthComputedUserRegistration {
    const persisted = decodePersistedAuthUser(user);
    return {
        usernameStorageKey: authNormalizedUsernameKey(persisted.normalizedUsername),
        clientIdStorageKey: authClientIdKey(persisted.clientId),
        serializedValue: encodeRuntimeStateJsonValue(persisted),
        expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
    };
}

function isMatchingUserRead(read: AuthMutationRead, user: PersistedAuthUser): boolean {
    return (
        read.kind === 'register-user' &&
        read.byUsername !== null &&
        read.byClientId !== null &&
        equalAuthJson(read.byUsername.value, user) &&
        equalAuthJson(read.byClientId.value, user)
    );
}

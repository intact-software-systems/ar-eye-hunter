import type { PersistedAuthUser } from '../../persistence/persisted-auth-user.ts';
import type { AuthMutationComputed, AuthMutationRead, RegisterAuthUserCommand } from '../auth-mutation-contracts.ts';
import { equalAuthJson } from '../validate/auth-mutation-validation.ts';

type RegisterAuthUserRead = Extract<AuthMutationRead, { kind: 'register-user'; }>;

export function computeAuthUserRegistration(
    command: RegisterAuthUserCommand,
    read: RegisterAuthUserRead
): AuthMutationComputed {
    return {
        command,
        read,
        sessions: [],
        agentTickets: [],
        logoutOutbox: null,
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

function isMatchingUserRead(read: AuthMutationRead, user: PersistedAuthUser): boolean {
    return (
        read.kind === 'register-user' &&
        read.byUsername !== null &&
        read.byClientId !== null &&
        equalAuthJson(read.byUsername.value, user) &&
        equalAuthJson(read.byClientId.value, user)
    );
}

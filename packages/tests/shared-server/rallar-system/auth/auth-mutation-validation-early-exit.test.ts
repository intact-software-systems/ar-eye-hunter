import { describe, expect, it } from 'vitest';

import type { AuthMutationCommand, AuthMutationRead } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';

const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessTokenDigest: 'access-token-digest',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000
} as const;
const user = {
    clientId: session.clientId,
    username: session.username,
    normalizedUsername: 'alice',
    displayName: null,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    passwordAlgorithm: 'pbkdf2-sha256',
    passwordIterations: 120_000,
    roles: ['member'],
    status: 'active',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000
} as const;
const identity = { version: 1, requestId: 'rejection-request', capturedAtEpochMs: 1_000 } as const;
const emptySessions = {
    byToken: null,
    bySession: null,
    expiredByTokenEntry: null,
    expiredBySessionEntry: null
} as const;

interface AuthValidationRejectionCase {
    readonly label: string;
    readonly command: AuthMutationCommand;
    readonly read: AuthMutationRead;
    readonly message: string;
    readonly status: number;
}

describe('auth mutation validation early exits', () => {
    it.each(createEarlyExitCases())('preserves $label rejection precedence', ({ command, read, message, status }) => {
        expect(() =>
            Reflect.apply(validateAuthMutation, undefined, [
                command,
                read,
                createComputedCandidate(command, read)
            ])
        ).toThrowError(
            expect.objectContaining({ message, status, code: 'auth-mutation-rejected' })
        );
    });

    it('rejects a mismatched read operation before inspecting its authority', () => {
        const command: AuthMutationCommand = { ...identity, kind: 'logout-session', expected: session };
        const read: AuthMutationRead = { kind: 'consume-ws-ticket', ticket: null, session: null };

        expect(() =>
            Reflect.apply(validateAuthMutation, undefined, [
                command,
                read,
                createComputedCandidate(command, read)
            ])
        ).toThrow(
            'Auth command/read operation differs'
        );
    });
});

function createEarlyExitCases(): readonly AuthValidationRejectionCase[] {
    return [createRegistrationCase(), createSessionCase(), createWebSocketCase(), createAgentCase()];
}

function createRegistrationCase(): AuthValidationRejectionCase {
    return {
        label: 'username collision before client-index corruption',
        command: { ...identity, kind: 'register-user', user },
        read: {
            kind: 'register-user',
            byUsername: createEntry({ ...user, clientId: 'other-client' }),
            byClientId: createEntry({ ...user, normalizedUsername: 'other-user' })
        },
        message: 'Auth username already exists',
        status: 409
    };
}

function createSessionCase(): AuthValidationRejectionCase {
    return {
        label: 'missing computed session before index/authority conflicts',
        command: {
            ...identity,
            kind: 'issue-session',
            authority: { kind: 'static-client', clientId: session.clientId, normalizedUsername: 'alice' },
            session
        },
        read: {
            kind: 'issue-session',
            ...emptySessions,
            byToken: createEntry({ ...session, clientId: 'other-client' }),
            userByUsername: createEntry(user),
            userByClientId: createEntry(user)
        },
        message: 'Issued auth session is missing',
        status: 409
    };
}

function createWebSocketCase(): AuthValidationRejectionCase {
    return {
        label: 'missing ticket before missing session authority',
        command: {
            ...identity,
            kind: 'consume-ws-ticket',
            ticketDigest: 'ticket-digest',
            expectedSessionId: session.sessionId
        },
        read: { kind: 'consume-ws-ticket', ticket: null, session: null },
        message: 'Auth ticket is invalid or consumed',
        status: 404
    };
}

function createAgentCase(): AuthValidationRejectionCase {
    return {
        label: 'empty ticket batch before missing authority',
        command: { ...identity, kind: 'issue-agent-tickets', authority: session, tickets: [] },
        read: { kind: 'issue-agent-tickets', authority: emptySessions, sessions: [], tickets: [], expiredTicketEntries: [] },
        message: 'Agent ticket batch is invalid',
        status: 409
    };
}

function createComputedCandidate(command: AuthMutationCommand, read: AuthMutationRead) {
    return {
        kind: command.kind,
        command,
        read,
        result: { requestId: command.requestId, loggedOut: true },
        sessions: [],
        agentTickets: [],
        logoutOutbox: null,
        ticketDeletion: null,
        ticketWrites: [],
        userRegistration: null,
        outcome: 'write'
    };
}

function createEntry<T>(value: T): RuntimeStateEntryValue<T> {
    return {
        value,
        entry: {
            key: 'authority',
            value: JSON.stringify(value),
            revision: 0,
            expireAtTimestamp: 2_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z'
        }
    };
}

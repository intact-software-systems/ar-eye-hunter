import { describe, expect, it } from 'vitest';

import type { AuthMutationCommand, AuthMutationComputed, AuthMutationRead } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';

const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessTokenDigest: 'access-token-digest',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000
} as const;

describe('auth mutation validation early exits', () => {
    it.each(validationEarlyExitCases())(
        '$label rejects before accessing later validation inputs',
        ({ command, read, message, readAccesses }) => {
            const accesses: string[] = [];
            const trackedRead = trackRead(read, accesses);

            expect(() => validateAuthMutation(command, trackedRead, computed(command, trackedRead))).toThrow(message);
            expect(accesses).toEqual(readAccesses);
        }
    );

    it('preserves the router command/read discriminant access sequence', () => {
        const counts = { command: 0, read: 0 };
        const command = trackKind(
            {
                version: 1,
                kind: 'logout-session',
                requestId: 'logout-request',
                capturedAtEpochMs: 1_000,
                expected: {} as never
            } as AuthMutationCommand,
            counts,
            'command'
        );
        const read = trackKind(
            {
                kind: 'logout-session',
                byToken: null,
                bySession: null,
                expiredByTokenEntry: null,
                expiredBySessionEntry: null
            } as AuthMutationRead,
            counts,
            'read'
        );

        validateAuthMutation(command, read, computed(command, read));

        expect(counts).toEqual({ command: 2, read: 1 });
    });
});

function validationEarlyExitCases() {
    return [
        registerUserEarlyExit(),
        issueSessionEarlyExit(),
        consumeWebSocketTicketEarlyExit(),
        issueAgentTicketEarlyExit()
    ];
}

function registerUserEarlyExit() {
    const command = {
        version: 1,
        kind: 'register-user',
        requestId: 'register-request',
        capturedAtEpochMs: 1_000,
        user: { clientId: 'client-1' }
    } as AuthMutationCommand;
    const read = {
        kind: 'register-user',
        byUsername: { value: { clientId: 'different-client' } },
        get byClientId() {
            throw new Error('Registration should stop before the client index');
        }
    } as unknown as AuthMutationRead;
    return rejectionCase({
        command,
        read,
        message: 'Auth username already exists',
        readAccesses: ['kind', 'byUsername', 'byUsername']
    });
}

function issueSessionEarlyExit() {
    const command = {
        version: 1,
        kind: 'issue-session',
        requestId: 'issue-session-request',
        capturedAtEpochMs: 1_000,
        authority: { kind: 'static-client', clientId: 'client-1', normalizedUsername: 'alice' },
        session
    } as AuthMutationCommand;
    const read = {
        kind: 'issue-session',
        get byToken() {
            throw new Error('Missing computed session must stop before runtime indexes');
        },
        get userByUsername() {
            throw new Error('Missing computed session must stop before user authority');
        }
    } as unknown as AuthMutationRead;
    return rejectionCase({
        command,
        read,
        message: 'Issued auth session is missing',
        readAccesses: ['kind']
    });
}

function consumeWebSocketTicketEarlyExit() {
    const command = {
        version: 1,
        kind: 'consume-ws-ticket',
        requestId: 'consume-websocket-ticket-request',
        capturedAtEpochMs: 1_000,
        ticketDigest: 'websocket-ticket-digest',
        expectedSessionId: session.sessionId
    } as AuthMutationCommand;
    const read = {
        kind: 'consume-ws-ticket',
        ticket: null,
        get session() {
            throw new Error('Missing ticket must stop before session authority');
        }
    } as unknown as AuthMutationRead;
    return rejectionCase({
        command,
        read,
        message: 'Auth ticket is invalid or consumed',
        readAccesses: ['kind', 'ticket']
    });
}

function issueAgentTicketEarlyExit() {
    const command = {
        version: 1,
        kind: 'issue-agent-tickets',
        requestId: 'issue-agent-ticket-request',
        capturedAtEpochMs: 1_000,
        authority: session,
        tickets: []
    } as AuthMutationCommand;
    const read = {
        kind: 'issue-agent-tickets',
        get authority() {
            throw new Error('Invalid ticket batch must stop before authority');
        }
    } as unknown as AuthMutationRead;
    return rejectionCase({
        command,
        read,
        message: 'Agent ticket batch is invalid',
        readAccesses: ['kind']
    });
}

interface RejectionCaseInput {
    readonly command: AuthMutationCommand;
    readonly read: AuthMutationRead;
    readonly message: string;
    readonly readAccesses: readonly string[];
}

function rejectionCase({ command, read, message, readAccesses }: RejectionCaseInput) {
    return { label: command.kind, command, read, message, readAccesses };
}

function computed(command: AuthMutationCommand, read: AuthMutationRead): AuthMutationComputed {
    return {
        command,
        read,
        result: {} as AuthMutationComputed['result'],
        sessions: [],
        agentTickets: [],
        logoutOutbox: null,
        outcome: 'write'
    };
}

function trackRead<T extends AuthMutationRead>(read: T, accesses: string[]): T {
    return new Proxy(read, {
        get(target, property, receiver) {
            if (typeof property === 'string') {
                accesses.push(property);
            }
            return Reflect.get(target, property, receiver);
        }
    });
}

function trackKind<T extends Readonly<{ kind: string; }>>(
    value: T,
    counts: Record<'command' | 'read', number>,
    count: 'command' | 'read'
): T {
    return new Proxy(value, {
        get(target, property, receiver) {
            if (property === 'kind') {
                counts[count] += 1;
            }
            return Reflect.get(target, property, receiver);
        }
    });
}

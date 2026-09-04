import { describe, expect, it } from 'vitest';

import type { AuthMutationCommand, AuthMutationRead } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';

const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessTokenDigest: 'access-token-digest',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000
} as const;
const websocketTicket = {
    ticketDigest: 'websocket-ticket-digest',
    accessTokenDigest: session.accessTokenDigest,
    sessionId: session.sessionId,
    clientId: session.clientId,
    issuedAtEpochMs: 1_001,
    expiresAtEpochMs: 1_500
} as const;
const agentTicket = {
    ticketDigest: 'agent-ticket-digest',
    accessTokenDigest: session.accessTokenDigest,
    sessionId: session.sessionId,
    clientId: session.clientId,
    agentId: 'agent-1',
    issuedAtEpochMs: 1_001,
    expiresAtEpochMs: 1_500
} as const;

describe('auth consumed-ticket compute evaluation order', () => {
    it('rejects a missing session before reading either consumed ticket value', () => {
        for (const testCase of missingSessionCases()) {
            const rejection = catchComputeRejection(testCase.command, testCase.read);

            expect(rejection, testCase.label).toBeInstanceOf(AuthMutationRejectedError);
            expect(rejection, testCase.label).toMatchObject({
                message: testCase.message,
                status: 404
            });
            expect(testCase.reads, testCase.label).toEqual([]);
        }
    });

    it('reads each consumed session entry once before projecting its result', () => {
        for (const testCase of consumedSessionCases()) {
            compute(testCase.command, testCase.read);

            expect(testCase.reads, testCase.label).toEqual(['session.value']);
        }
    });
});

describe('auth logout compute evaluation order', () => {
    it('evaluates the result and outcome before constructing the logout outbox', () => {
        const reads: string[] = [];
        const command = new Proxy(logoutCommand, {
            get(target, property, receiver) {
                if (property === 'requestId') {
                    reads.push('command.requestId');
                }
                return Reflect.get(target, property, receiver);
            }
        });
        const persistedSession = entry(session, 'session=session-1');
        const read = {
            kind: 'logout-session',
            get byToken() {
                reads.push('read.byToken');
                return persistedSession;
            },
            get bySession() {
                reads.push('read.bySession');
                return persistedSession;
            },
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        } satisfies AuthMutationRead;

        compute(command, read);

        expect(reads.slice(0, 3)).toEqual(['command.requestId', 'read.bySession', 'read.bySession']);
    });
});

function compute(command: AuthMutationCommand, read: AuthMutationRead) {
    return computeAuthMutation({
        command,
        read,
        facts: { kind: command.kind, serviceId: 'auth-service' }
    });
}

function catchComputeRejection(command: AuthMutationCommand, read: AuthMutationRead): Error {
    try {
        compute(command, read);
    }
    catch (error) {
        return error instanceof Error
            ? error
            : new TypeError('Auth compute rejected with a non-Error value');
    }
    throw new Error('Expected auth compute rejection');
}

function missingSessionCases() {
    const websocketReads: string[] = [];
    const agentReads: string[] = [];
    return [
        {
            label: 'websocket ticket',
            command: consumeWebSocketCommand,
            read: {
                kind: 'consume-ws-ticket',
                ticket: trackedEntry(websocketTicket, 'ticket.value', websocketReads),
                session: null
            },
            message: 'Websocket ticket session is unavailable',
            reads: websocketReads
        },
        {
            label: 'agent ticket',
            command: consumeAgentCommand,
            read: {
                kind: 'consume-agent-ticket',
                ticket: trackedEntry(agentTicket, 'ticket.value', agentReads),
                session: null
            },
            message: 'Agent ticket session is unavailable',
            reads: agentReads
        }
    ] satisfies readonly Readonly<{
        label: string;
        command: AuthMutationCommand;
        read: AuthMutationRead;
        message: string;
        reads: string[];
    }>[];
}

function consumedSessionCases() {
    const websocketReads: string[] = [];
    const agentReads: string[] = [];
    return [
        {
            label: 'websocket ticket',
            command: consumeWebSocketCommand,
            read: {
                kind: 'consume-ws-ticket',
                ticket: entry(websocketTicket, 'ticket=websocket-ticket-digest'),
                session: trackedEntry(session, 'session.value', websocketReads)
            },
            reads: websocketReads
        },
        {
            label: 'agent ticket',
            command: consumeAgentCommand,
            read: {
                kind: 'consume-agent-ticket',
                ticket: entry(agentTicket, 'ticket=agent-ticket-digest'),
                session: trackedEntry(session, 'session.value', agentReads)
            },
            reads: agentReads
        }
    ] satisfies readonly Readonly<{
        label: string;
        command: AuthMutationCommand;
        read: AuthMutationRead;
        reads: string[];
    }>[];
}

function trackedEntry<T>(value: T, label: string, reads: string[]) {
    return {
        entry: runtimeEntry(value, label),
        get value() {
            reads.push(label);
            return value;
        }
    };
}

function entry<T>(value: T, key: string) {
    return { entry: runtimeEntry(value, key), value };
}

function runtimeEntry<T>(value: T, key: string) {
    return {
        key,
        value: JSON.stringify(value),
        expireAtTimestamp: 2_000,
        updatedTimestamp: '1970-01-01T00:00:01.000Z',
        revision: 0
    };
}

const consumeWebSocketCommand = {
    version: 1,
    kind: 'consume-ws-ticket',
    requestId: 'consume-websocket-request',
    capturedAtEpochMs: 1_002,
    ticketDigest: websocketTicket.ticketDigest,
    expectedSessionId: session.sessionId
} as const;

const consumeAgentCommand = {
    version: 1,
    kind: 'consume-agent-ticket',
    requestId: 'consume-agent-request',
    capturedAtEpochMs: 1_002,
    ticketDigest: agentTicket.ticketDigest
} as const;

const logoutCommand = {
    version: 1,
    kind: 'logout-session',
    requestId: 'logout-request',
    capturedAtEpochMs: 1_001,
    expected: session
} as const;

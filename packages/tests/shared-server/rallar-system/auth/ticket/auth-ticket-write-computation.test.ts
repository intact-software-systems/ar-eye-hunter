import { describe, expect, it } from 'vitest';

import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation, type ComputeAuthMutationInput } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';

const session = {
    clientId: 'client',
    username: 'alice',
    sessionId: 'session:value',
    accessTokenDigest: 'token:value',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 3_000
} as const;
const webSocketTicket = {
    ticketDigest: 'ticket:value',
    accessTokenDigest: session.accessTokenDigest,
    sessionId: session.sessionId,
    clientId: session.clientId,
    issuedAtEpochMs: 1_001,
    expiresAtEpochMs: 2_000
} as const;

describe('computed auth ticket writes', () => {
    it('computes the exact WebSocket ticket write with a zero-valued replacement revision', () => {
        const input = createWebSocketInput();

        expect(computeAuthMutation(input)).toMatchObject({
            ticketWrites: [{
                namespace: 'auth-sessions:ws-tickets',
                storageKey: 'ticket-digest=ticket%3Avalue',
                serializedValue: JSON.stringify(webSocketTicket),
                expireAtIsoTimestamp: '1970-01-01T00:00:02.000Z',
                expectedRevision: 0
            }]
        });
    });

    it('computes the exact agent ticket write independently of its session write', () => {
        const ticket = {
            agentId: 'agent',
            sessionId: 'agent-session',
            accessTokenDigest: 'agent-token',
            ticketDigest: 'agent-ticket',
            clientId: session.clientId,
            username: session.username,
            issuedAtEpochMs: 1_001,
            sessionExpiresAtEpochMs: 3_000,
            ticketExpiresAtEpochMs: 2_000
        } as const;
        const input: ComputeAuthMutationInput = {
            command: {
                version: 1,
                kind: 'issue-agent-tickets',
                requestId: 'agent-ticket',
                capturedAtEpochMs: 1_001,
                authority: session,
                tickets: [ticket]
            },
            read: {
                kind: 'issue-agent-tickets',
                authority: emptySessionRead(),
                sessions: [emptySessionRead()],
                tickets: [null],
                expiredTicketEntries: [null]
            },
            facts: { kind: 'issue-agent-tickets' },
            serviceId: 'auth'
        };
        const persisted = {
            ticketDigest: ticket.ticketDigest,
            accessTokenDigest: ticket.accessTokenDigest,
            sessionId: ticket.sessionId,
            clientId: ticket.clientId,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
            agentId: ticket.agentId
        };

        expect(computeAuthMutation(input)).toMatchObject({
            ticketWrites: [{
                namespace: 'auth-sessions:agent-session-tickets',
                storageKey: 'ticket-digest=agent-ticket',
                serializedValue: JSON.stringify(persisted),
                expireAtIsoTimestamp: '1970-01-01T00:00:02.000Z',
                expectedRevision: null
            }]
        });
    });

    it.each([
        { namespace: 'auth-sessions:agent-session-tickets' as const },
        { storageKey: 'ticket-digest=forged' },
        { serializedValue: '{}' },
        { expireAtIsoTimestamp: '2000-01-01T00:00:00.000Z' },
        { expectedRevision: 1 }
    ])('rejects altered computed ticket persistence: %o', (change) => {
        const input = createWebSocketInput();
        const computed = computeAuthMutation(input);
        const candidate = {
            ...computed,
            ticketWrites: [{ ...computed.ticketWrites[0], ...change }]
        };

        expect(() => Reflect.apply(validateAuthMutation, undefined, [input.command, input.read, candidate])).toThrow(AuthMutationRejectedError);
        expect(candidate.ticketWrites[0]).toMatchObject(change);
    });
});

function createWebSocketInput(): ComputeAuthMutationInput {
    return {
        command: {
            version: 1,
            kind: 'issue-ws-ticket',
            requestId: 'ws-ticket',
            capturedAtEpochMs: 1_001,
            ticketRecord: webSocketTicket
        },
        read: {
            kind: 'issue-ws-ticket',
            ticket: null,
            expiredTicketEntry: createReadEntry('ticket-digest=ticket%3Avalue', '{}').entry,
            session: createReadEntry('session=session%3Avalue', session)
        },
        facts: { kind: 'issue-ws-ticket' },
        serviceId: 'auth'
    };
}

function emptySessionRead() {
    return {
        byToken: null,
        bySession: null,
        expiredByTokenEntry: null,
        expiredBySessionEntry: null
    } as const;
}

function createReadEntry<T>(key: string, value: T): RuntimeStateEntryValue<T> {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            revision: 0,
            expireAtTimestamp: 2_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z'
        },
        value
    };
}

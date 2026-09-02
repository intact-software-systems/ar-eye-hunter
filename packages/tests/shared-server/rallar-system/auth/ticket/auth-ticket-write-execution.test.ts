import { describe, expect, it } from 'vitest';

import { computeAuthMutation, type ComputeAuthMutationInput } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import { writeAuthMutation } from '@shared-server/rallar-system/auth/mutation/write/write-auth-mutation.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAuthInboxTestRuntime } from '../auth-app-inbox-test-runtime.ts';

const authority = {
    clientId: 'client',
    username: 'alice',
    sessionId: 'authority-session',
    accessTokenDigest: 'authority-token',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 3_000
} as const;

describe('auth ticket write execution', () => {
    it('writes a computed WebSocket ticket without inspecting the command ticket', async () => {
        const input = createWebSocketInput();
        const computed = computeAuthMutation(input);
        validateAuthMutation(input.command, input.read, computed);
        let ticketReadsDuringWrite = 0;
        Object.defineProperty(input.command, 'ticketRecord', {
            get: () => {
                ticketReadsDuringWrite += 1;
                throw new Error('Command ticket inspected inside write');
            }
        });
        const runtime = new FakeRuntimeStateRepository();
        const harness = createAuthRuntime(runtime);

        await harness.database.begin((transaction) => writeAuthMutation(transaction, computed));

        expect(ticketReadsDuringWrite).toBe(0);
        expect(await runtime.findEntry('auth-sessions:ws-tickets', 'ticket-digest=ws-ticket')).toMatchObject({
            value: computed.ticketWrites[0]!.serializedValue,
            expireAtTimestamp: 2_000
        });
    });

    it('writes computed agent sessions and tickets without inspecting old ticket projections', async () => {
        const input = createAgentInput();
        const computed = computeAuthMutation(input);
        validateAuthMutation(input.command, input.read, computed);
        let oldProjectionReadsDuringWrite = 0;
        for (
            const [owner, field] of [
                [computed, 'agentTickets'],
                [input.read, 'expiredTicketEntries']
            ] as const
        ) {
            Object.defineProperty(owner, field, {
                get: () => {
                    oldProjectionReadsDuringWrite += 1;
                    throw new Error('Old ticket projection inspected inside write');
                }
            });
        }
        const runtime = new FakeRuntimeStateRepository();
        const harness = createAuthRuntime(runtime);

        await harness.database.begin((transaction) => writeAuthMutation(transaction, computed));

        expect(oldProjectionReadsDuringWrite).toBe(0);
        expect(await runtime.findEntry('auth-sessions:agent-session-tickets', 'ticket-digest=agent-ticket')).toMatchObject({
            value: computed.ticketWrites[0]!.serializedValue,
            expireAtTimestamp: 2_000
        });
        expect(await runtime.findEntry('auth-sessions:by-session', 'session=agent-session')).toMatchObject({
            value: computed.sessions[0].serializedValue,
            expireAtTimestamp: 3_000
        });
    });
});

function createWebSocketInput(): ComputeAuthMutationInput {
    const ticket = {
        ticketDigest: 'ws-ticket',
        accessTokenDigest: authority.accessTokenDigest,
        sessionId: authority.sessionId,
        clientId: authority.clientId,
        issuedAtEpochMs: 1_001,
        expiresAtEpochMs: 2_000
    } as const;
    return {
        command: {
            version: 1,
            kind: 'issue-ws-ticket',
            requestId: 'ws-ticket',
            capturedAtEpochMs: 1_001,
            ticketRecord: ticket
        },
        read: {
            kind: 'issue-ws-ticket',
            ticket: null,
            expiredTicketEntry: null,
            session: createReadEntry('session=authority-session', authority)
        },
        facts: { kind: 'issue-ws-ticket' },
        serviceId: 'auth'
    };
}

function createAgentInput(): ComputeAuthMutationInput {
    const ticket = {
        agentId: 'agent',
        sessionId: 'agent-session',
        accessTokenDigest: 'agent-token',
        ticketDigest: 'agent-ticket',
        clientId: authority.clientId,
        username: authority.username,
        issuedAtEpochMs: 1_001,
        sessionExpiresAtEpochMs: 3_000,
        ticketExpiresAtEpochMs: 2_000
    } as const;
    return {
        command: {
            version: 1,
            kind: 'issue-agent-tickets',
            requestId: 'agent-ticket',
            capturedAtEpochMs: 1_001,
            authority,
            tickets: [ticket]
        },
        read: {
            kind: 'issue-agent-tickets',
            authority: {
                byToken: createReadEntry('token-digest=authority-token', authority),
                bySession: createReadEntry('session=authority-session', authority),
                expiredByTokenEntry: null,
                expiredBySessionEntry: null
            },
            sessions: [emptySessionRead()],
            tickets: [null],
            expiredTicketEntries: [null]
        },
        facts: { kind: 'issue-agent-tickets' },
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
            expireAtTimestamp: value === authority ? authority.expiresAtEpochMs : 2_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z'
        },
        value
    };
}

function createAuthRuntime(runtimeRepository: FakeRuntimeStateRepository) {
    return createAuthInboxTestRuntime({
        runtimeRepository,
        serviceId: 'auth-ticket-write',
        credentialSecret: 'test-secret-0123456789abcdef0123456789abcdef'
    });
}

import { describe, expect, it } from 'vitest';

import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation, type ComputeAuthMutationInput } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import { writeAuthMutation } from '@shared-server/rallar-system/auth/mutation/write/write-auth-mutation.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAuthInboxTestRuntime } from '../auth-app-inbox-test-runtime.ts';

const session = {
    clientId: 'client',
    username: 'alice',
    sessionId: 'session:value',
    accessTokenDigest: 'token:value',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 61_000
};

describe.each(['consume-ws-ticket', 'consume-agent-ticket'] as const)('%s deletion computation', (kind) => {
    it('computes the exact storage key and zero-valued expected revision', () => {
        const input = createTicketInput(kind);
        const computed = computeAuthMutation(input);

        expect(computed.ticketDeletion).toEqual({ storageKey: 'ticket-digest=ticket%3Avalue', expectedRevision: 0 });
        expect(() => validateAuthMutation(input.command, input.read, computed)).not.toThrow();
    });

    it.each([
        null,
        { storageKey: 'ticket-digest=forged', expectedRevision: 0 },
        { storageKey: 'ticket-digest=ticket%3Avalue', expectedRevision: 1 }
    ])('rejects a missing or altered computed deletion', (ticketDeletion) => {
        const input = createTicketInput(kind);
        const computed = { ...computeAuthMutation(input), ticketDeletion };

        expect(() => Reflect.apply(validateAuthMutation, undefined, [input.command, input.read, computed])).toThrow(AuthMutationRejectedError);
        expect(computed.ticketDeletion).toEqual(ticketDeletion);
    });

    it('deletes from computed data without inspecting the prior-read ticket inside write', async () => {
        const input = createTicketInput(kind);
        const computed = computeAuthMutation(input);
        validateAuthMutation(input.command, input.read, computed);
        const runtime = new FakeRuntimeStateRepository();
        const namespace = kind === 'consume-ws-ticket' ? 'auth-sessions:ws-tickets' : 'auth-sessions:agent-session-tickets';
        await runtime.insertIfAbsent(namespace, 'ticket-digest=ticket%3Avalue', '{}', '1970-01-01T00:01:01.000Z');
        const harness = createAuthInboxTestRuntime({
            runtimeRepository: runtime,
            serviceId: 'auth-delete',
            credentialSecret: 'test-secret-0123456789abcdef0123456789abcdef'
        });
        let readsDuringWrite = 0;
        Object.defineProperty(input.read, 'ticket', {
            get: () => {
                readsDuringWrite += 1;
                throw new Error('Prior ticket read inspected inside write');
            }
        });

        const result = await harness.database.begin((transaction) => writeAuthMutation(transaction, computed));

        expect(readsDuringWrite).toBe(0);
        expect(await runtime.findEntry(namespace, 'ticket-digest=ticket%3Avalue')).toBeUndefined();
        expect(result).toEqual({
            requestId: 'ticket-delete',
            kind: kind === 'consume-ws-ticket' ? 'ws-ticket-consumed' : 'agent-ticket-consumed',
            ...session
        });
    });
});

function createTicketInput(kind: 'consume-ws-ticket' | 'consume-agent-ticket'): ComputeAuthMutationInput {
    const ticket = {
        ticketDigest: 'ticket:value',
        accessTokenDigest: session.accessTokenDigest,
        sessionId: session.sessionId,
        clientId: session.clientId,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 31_000
    };
    const command = { version: 1, requestId: 'ticket-delete', capturedAtEpochMs: 1_001, ticketDigest: ticket.ticketDigest } as const;
    const facts = { kind };
    const storedSession = createReadEntry('session=session%3Avalue', session);
    return kind === 'consume-ws-ticket'
        ? {
            command: { ...command, kind, expectedSessionId: session.sessionId },
            read: { kind, ticket: createReadEntry('ticket-digest=ticket%3Avalue', ticket), session: storedSession },
            facts,
            serviceId: 'auth'
        }
        : {
            command: { ...command, kind },
            read: { kind, ticket: createReadEntry('ticket-digest=ticket%3Avalue', { ...ticket, agentId: 'agent' }), session: storedSession },
            facts,
            serviceId: 'auth'
        };
}

function createReadEntry<T extends { expiresAtEpochMs: number; }>(key: string, value: T): RuntimeStateEntryValue<T> {
    return {
        value,
        entry: { key, value: JSON.stringify(value), revision: 0, expireAtTimestamp: value.expiresAtEpochMs, updatedTimestamp: '1970-01-01T00:00:01.000Z' }
    };
}

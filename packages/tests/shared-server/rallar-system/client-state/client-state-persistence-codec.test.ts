import {
    decodePersistedClientEvent,
    decodePersistedClientInstance,
    decodePersistedClientPrincipal,
    decodePersistedClientSession
} from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { describe, expect, it } from 'vitest';

import { AggregateBarrierRepository, CLIENT_MUTATION_BASE_EPOCH_MS, connect } from './client-mutation-concurrency-test-runtime.ts';
import { clientMutationPrincipalRef } from './client-mutation-validation-test-fixtures.ts';

describe('client-state persistence codec', () => {
    // A stored value is parsed afresh from its text on every read, so the decoder hands out the
    // validated value itself rather than a copy.
    it('returns the validated stored principal, instance and session themselves', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect({ runtime, sessionId: 'codec-session', generationId: 'codec-generation', nowEpochMs: CLIENT_MUTATION_BASE_EPOCH_MS });
        const principalRef = clientMutationPrincipalRef('alice');
        const principal = await readStoredValue(runtime, 'client-state:principals');
        const instance = await readStoredValue(runtime, 'client-state:instances');
        const session = await readStoredValue(runtime, 'client-state:sessions');

        expect(decodePersistedClientPrincipal(principal, principalRef)).toBe(principal);
        expect(decodePersistedClientInstance(instance, { ...principalRef, clientInstanceId: 'browser' })).toBe(instance);
        expect(
            decodePersistedClientSession(session, {
                ...principalRef,
                clientInstanceId: 'browser',
                sessionId: 'codec-session'
            })
        ).toBe(session);
    });

    it('returns the validated stored event itself', () => {
        const event = JSON.parse(JSON.stringify(clientEvent()));

        expect(decodePersistedClientEvent(event, clientMutationPrincipalRef('alice'))).toBe(event);
    });
});

async function readStoredValue(runtime: AggregateBarrierRepository, namespace: string): Promise<object> {
    const [entry] = await runtime.findAllEntries(namespace);
    if (!entry) {
        throw new Error(`Expected a stored ${namespace} entry`);
    }
    return JSON.parse(entry.value);
}

function clientEvent(): ClientEvent {
    return {
        ...clientMutationPrincipalRef('alice'),
        eventId: 'codec-event',
        eventType: 'principal-created',
        snapshotVersion: 1,
        occurredAtEpochMs: 1_000,
        actor: { kind: 'service', serviceId: 'codec-test' },
        reason: null,
        traceId: null,
        requestId: null,
        clientInstanceId: null,
        sessionId: null,
        payload: {}
    };
}

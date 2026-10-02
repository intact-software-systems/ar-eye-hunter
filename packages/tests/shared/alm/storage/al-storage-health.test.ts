import { describe, expect, it, vi } from 'vitest';

import { toALStorageResetSink, type ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';

const QUOTA: ALStorageUnavailable = { cause: 'quota', detail: 'QuotaExceededError: full' };
const CLOSED: ALStorageUnavailable = { cause: 'closed', detail: 'InvalidStateError: closed' };

describe('ALStorageHealth', () => {
    it('starts healthy and states nothing until the first failure', async () => {
        const { events } = createHealth();

        await flushListeners();

        expect(events).toEqual([]);
    });

    it('states failing once on the first failure, with no recovery point yet', async () => {
        const { health, events } = createHealth();

        health.recordFailure(QUOTA);
        health.recordFailure(CLOSED);

        await vi.waitFor(() => expect(events).toHaveLength(1));
        await flushListeners();
        expect(events).toEqual([{
            kind: 'health',
            storeId: 'browser-ws-client:session-1',
            status: 'failing',
            lastFailure: QUOTA,
            lastRecoveryPointAtMs: undefined
        }]);
    });

    // The harness waits match the emitted JSON as text, so the key order is part of the event.
    it('states the health keys in a fixed order and keeps the failure on healthy', async () => {
        const { health, events } = createHealth();

        health.recordFailure(QUOTA);
        health.recordRecoveryPoint(2_000);

        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events.map((event) => JSON.stringify(event))).toEqual([
            '{"kind":"health","storeId":"browser-ws-client:session-1","status":"failing","lastFailure":{"cause":"quota","detail":"QuotaExceededError: full"}}',
            '{"kind":"health","storeId":"browser-ws-client:session-1","status":"healthy","lastFailure":{"cause":"quota","detail":"QuotaExceededError: full"},"lastRecoveryPointAtMs":2000}'
        ]);
    });

    // Every durable commit is a recovery point; only the one that ends a failure is stated.
    it('states healthy at the first recovery point after a failure', async () => {
        const { health, events } = createHealth();

        health.recordRecoveryPoint(1_000);
        health.recordFailure(QUOTA);
        health.recordRecoveryPoint(2_000);
        health.recordRecoveryPoint(3_000);

        await vi.waitFor(() => expect(events).toHaveLength(2));
        await flushListeners();
        expect(events).toEqual([
            {
                kind: 'health',
                storeId: 'browser-ws-client:session-1',
                status: 'failing',
                lastFailure: QUOTA,
                lastRecoveryPointAtMs: 1_000
            },
            {
                kind: 'health',
                storeId: 'browser-ws-client:session-1',
                status: 'healthy',
                lastFailure: QUOTA,
                lastRecoveryPointAtMs: 2_000
            }
        ]);
    });

    it('states nothing for recovery points while healthy', async () => {
        const { health, events } = createHealth();

        health.recordRecoveryPoint(1_000);
        health.recordRecoveryPoint(2_000);
        await flushListeners();

        expect(events).toEqual([]);
    });

    it('keeps recording when the storage port throws', async () => {
        const events: ALStorageEvent[] = [];
        const health = new ALStorageHealth({
            storeId: 'browser-ws-client:session-1',
            storage: (event) => {
                events.push(event);
                throw new Error('sink failed');
            }
        });

        health.recordFailure(QUOTA);
        health.recordRecoveryPoint(1_000);

        await vi.waitFor(() =>
            expect(events.map((event) => event.kind === 'health' ? event.status : event.kind))
                .toEqual(['failing', 'healthy'])
        );
    });
});

describe('toALStorageResetSink', () => {
    it('states a reset of the store it names', () => {
        const events: ALStorageEvent[] = [];
        const reset = {
            dbName: 'rallar-al-runtime',
            previousSchemaId: 'old',
            schemaId: 'current',
            reason: 'schema-id-mismatch'
        } as const;

        toALStorageResetSink((event) => events.push(event), 'browser-ws-client:session-1')(reset);

        expect(events).toEqual([{
            kind: 'reset',
            storeId: 'browser-ws-client:session-1',
            event: reset
        }]);
    });
});

function createHealth(): Readonly<{ health: ALStorageHealth; events: ALStorageEvent[]; }> {
    const events: ALStorageEvent[] = [];
    const health = new ALStorageHealth({
        storeId: 'browser-ws-client:session-1',
        storage: (event) => events.push(event)
    });
    return { health, events };
}

/** The health listener runs on the value's promise queue; two macrotask turns drain it. */
async function flushListeners(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import {
    createCountingIndexedDbOperationObserver,
    createPassThroughIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createIndexedDbOutboundTestStores,
    createOutboundMessage,
    createRecordingOutboundTestRuntime,
    createVolatileOutboundTestStores,
    drainEngine,
    toOutboundTestAck,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';

const QUOTA = new DOMException('The quota has been exceeded.', 'QuotaExceededError');

describe('outbound storage unavailability', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // The failed transaction wrote nothing, so the send settles typed; the next commit is a recovery point.
    it('answers a send whose commit hits the quota storage-unavailable, then healthy at the next commit', async () => {
        const { stores, events } = createObservedStores();
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        vi.spyOn(stores.backend, 'write').mockRejectedValueOnce(QUOTA);

        const refused = await runtime.enqueueIfAbsent(createOutboundMessage('storage-quota'));
        const admitted = await runtime.enqueueIfAbsent(createOutboundMessage('storage-recovered'));

        expect(refused.verdict).toEqual({
            kind: 'storage-unavailable',
            cause: 'quota',
            detail: 'QuotaExceededError: The quota has been exceeded.'
        });
        expect(refused.entries).toEqual([]);
        expect(refused.trackedReceiptAlgo).toBe('none');
        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        await vi.waitFor(() => expect(events.map(toHealthStatus)).toEqual(['failing', 'healthy']));
        expect(events[0]).toMatchObject({ lastFailure: { cause: 'quota' } });
    });

    // Every member of a group whose commit hits the quota is answered alone, each with its own verdict.
    it('answers each member of a group storage-unavailable when every commit hits the quota', async () => {
        const { stores } = createObservedStores();
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        vi.spyOn(stores.backend, 'write').mockRejectedValue(QUOTA);

        const results = await runtime.enqueueAllIfAbsent([
            createOutboundMessage('storage-group-1'),
            createOutboundMessage('storage-group-2')
        ]);

        expect(results.map((result) => result.verdict.kind)).toEqual([
            'storage-unavailable',
            'storage-unavailable'
        ]);
    });

    // The lane's start answers the failed open as a value; the send reopens, fails again and settles typed.
    it('answers a durable send storage-unavailable while its store cannot open', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const events: ALStorageEvent[] = [];
        const stores = {
            ...createIndexedDbOutboundTestStores({
                observer: createPassThroughIndexedDbOperationObserver(),
                namespace: 'outbound-missing'
            }),
            storageHealth: new ALStorageHealth({
                storeId: 'outbound-missing',
                storage: (event) => events.push(event)
            })
        };
        const runtime = createRecordingOutboundTestRuntime(stores, []);

        const readiness = await runtime.ready();
        const result = await runtime.enqueueIfAbsent(createOutboundMessage('storage-missing'));

        const missing = {
            cause: 'missing',
            detail: 'IndexedDB is not available in this environment'
        } as const;
        expect(readiness.left).toEqual(missing);
        expect(result.verdict).toEqual({ kind: 'storage-unavailable', ...missing });
        await vi.waitFor(() => expect(events.map(toHealthStatus)).toEqual(['failing']));
    });

    // A lane whose open failed starts no work, so the engine's passes probe nothing and health states failing once.
    it('keeps the volatile lane admitting and the durable lane idle while its store cannot open', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const events: ALStorageEvent[] = [];
        const observer = createCountingIndexedDbOperationObserver();
        const engine = new InboxOutboxEngine();
        const volatileStores = createVolatileOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            queueEngine: engine,
            stores: {
                ...createIndexedDbOutboundTestStores({
                    observer,
                    namespace: 'outbound-missing-volatile'
                }),
                storageHealth: new ALStorageHealth({
                    storeId: 'outbound-missing',
                    storage: (event) => events.push(event)
                })
            },
            volatileStores,
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        const readiness = await runtime.ready();
        const fleeting = createOutboundMessage('volatile-without-storage');
        const result = await runtime.enqueueIfAbsent(fleeting);
        for (let pass = 0; pass < 3; pass += 1) {
            await drainEngine(engine);
        }

        expect(readiness.left?.cause).toBe('missing');
        expect(result.verdict.kind).toBe('admitted');
        expect(await volatileStores.admissionStore.hasSentMessageAdmission(fleeting.id.msgId)).toBe(
            true
        );
        expect(observer.getCounts().byOwner['al-work']).toBe(0);
        await vi.waitFor(() => expect(events.map(toHealthStatus)).toEqual(['failing']));
        runtime.dispose();
    });

    // The caller tells this from a foreign control: inside a claim it retries, inline it answers not handled.
    it('answers a control its store cannot read storage-unavailable', async () => {
        const { stores } = createObservedStores();
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        const sent = createOutboundMessage('storage-control');
        await runtime.enqueueIfAbsent(sent);
        vi.spyOn(stores.backend, 'read').mockRejectedValue(QUOTA);

        const admitted = await runtime.acceptControlMessage(toOutboundTestAck(sent, 'peer-1'), 'peer');

        expect(admitted).toEqual({
            kind: 'storage-unavailable',
            cause: 'quota',
            detail: 'QuotaExceededError: The quota has been exceeded.'
        });
    });

    it('leaves a commit failure that is no storage failure a throw', async () => {
        const { stores } = createObservedStores();
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        vi.spyOn(stores.backend, 'write').mockRejectedValueOnce(new Error('defect'));

        await expect(runtime.enqueueIfAbsent(createOutboundMessage('storage-defect'))).rejects
            .toThrow('defect');
    });
});

function createObservedStores(): Readonly<{ stores: OutboundTestStores; events: ALStorageEvent[]; }> {
    const events: ALStorageEvent[] = [];
    const stores: OutboundTestStores = {
        ...createDefaultOutboundTestStores(),
        storageHealth: new ALStorageHealth({
            storeId: 'outbound-test',
            storage: (event) => events.push(event)
        })
    };
    return { stores, events };
}

function toHealthStatus(event: ALStorageEvent): string {
    return event.kind === 'health' ? event.status : event.kind;
}

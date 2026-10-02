import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    configureBrowserALRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import {
    BrowserALStorageAvailability,
    computeALStorageAvailability,
    toBrowserStoragePersistRequest,
    type ALStorageAvailability,
    type BrowserStoragePersistRequest
} from '@shared-web/browser/al-runtime/browser-al-storage-availability.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

const AVAILABLE: ALStorageAvailability = { kind: 'available' };
const QUOTA: ALStorageAvailability = {
    kind: 'unavailable',
    reason: { cause: 'quota', detail: 'QuotaExceededError' }
};
const MISSING: ALStorageAvailability = {
    kind: 'unavailable',
    reason: { cause: 'missing', detail: 'No IndexedDB.' }
};

describe('the storage availability a connect decides', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // This file runs without fake-indexeddb, as a browser without IndexedDB does.
    it('reads missing without IndexedDB and gives the durable pairs no memory store to fall back on', async () => {
        const sessionId = `no-indexeddb-${crypto.randomUUID()}`;

        const storage = configureBrowserALRuntimeStores(sessionId, {
            scope: defaultStateScope(),
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
        });
        const outbound = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
        const inbound = resolveBrowserSessionALInboundRuntimeStores(sessionId);

        expect(storage.availability.get()).toEqual({
            kind: 'unavailable',
            reason: { cause: 'missing', detail: expect.any(String) }
        });
        expect(outbound.workQueue).not.toBeInstanceOf(InMemoryQueueBox);
        expect(inbound.workQueue).not.toBeInstanceOf(InMemoryQueueBox);
        await expect(outbound.admissionStore.ready()).rejects.toSatisfy((error: Error) => toALStorageUnavailable(error)?.cause === 'missing');
    });

    it('reads available where IndexedDB exists', () => {
        vi.stubGlobal('indexedDB', fakeIndexedDB);

        const storage = configureBrowserALRuntimeStores(`indexeddb-${crypto.randomUUID()}`, {
            scope: defaultStateScope(),
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
        });

        expect(storage.availability.get()).toEqual(AVAILABLE);
    });
});

describe('a durable admission re-decides availability', () => {
    it.each<{
        label: string;
        previous: ALStorageAvailability;
        verdict: ALDeliveryAdmissionVerdict;
        next: ALStorageAvailability;
    }>([
        {
            label: 'a storage failure makes it unavailable with its cause',
            previous: AVAILABLE,
            verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'QuotaExceededError' },
            next: QUOTA
        },
        {
            label: 'a durable admission makes it available again',
            previous: QUOTA,
            verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 },
            next: AVAILABLE
        },
        {
            label: 'a volatile admission says nothing about storage',
            previous: QUOTA,
            verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
            next: QUOTA
        },
        {
            label: 'a refusal says nothing about storage',
            previous: QUOTA,
            verdict: { kind: 'refused', reason: 'oversized', detail: 'Too large.' },
            next: QUOTA
        }
    ])('$label', ({ previous, verdict, next }) => {
        expect(computeALStorageAvailability(previous, verdict)).toEqual(next);
    });

    it('skips the durable lane only while storage is missing; any other cause is tried again', () => {
        const missing = createStorageAvailability(MISSING, undefined, () => {});
        const quota = createStorageAvailability(QUOTA, undefined, () => {});
        const available = createStorageAvailability(AVAILABLE, undefined, () => {});

        expect(missing.getDurableLaneSkip()).toEqual({ cause: 'missing', detail: 'No IndexedDB.' });
        expect(quota.getDurableLaneSkip()).toBeUndefined();
        expect(available.getDurableLaneSkip()).toBeUndefined();
    });
});

describe('the request for persistent storage', () => {
    it('asks once and reports the outcome as a persist event after the call returns', async () => {
        const requestPersist = vi.fn(async () => true);
        const events: ALStorageEvent[] = [];
        const storage = createStorageAvailability(
            AVAILABLE,
            requestPersist,
            (event) => events.push(event)
        );

        storage.requestPersistentStorage();
        storage.requestPersistentStorage();

        expect(requestPersist).toHaveBeenCalledTimes(1);
        expect(events).toEqual([]);
        await vi.waitFor(() => expect(events).toEqual([{ kind: 'persist', outcome: 'granted' }]));
    });

    it.each<{ label: string; requestPersist: BrowserStoragePersistRequest; outcome: string; }>([
        { label: 'a refusal reads denied', requestPersist: async () => false, outcome: 'denied' },
        {
            label: 'a rejected request reads denied',
            requestPersist: async () => {
                throw new Error('persist failed');
            },
            outcome: 'denied'
        },
        {
            label: 'a browser without the API reads unsupported',
            requestPersist: undefined,
            outcome: 'unsupported'
        }
    ])('$label', async ({ requestPersist, outcome }) => {
        const events: ALStorageEvent[] = [];
        const storage = createStorageAvailability(
            AVAILABLE,
            requestPersist,
            (event) => events.push(event)
        );

        storage.requestPersistentStorage();

        await vi.waitFor(() => expect(events).toEqual([{ kind: 'persist', outcome }]));
    });

    // A browser that already persists this origin reads granted without being asked again.
    it('reads an earlier grant without asking again', async () => {
        const calls: string[] = [];
        const requestPersist = toBrowserStoragePersistRequest({
            persisted: async () => {
                calls.push('persisted');
                return true;
            },
            persist: async () => {
                calls.push('persist');
                return true;
            }
        });

        await expect(requestPersist?.()).resolves.toBe(true);
        expect(calls).toEqual(['persisted']);
    });

    it('asks after reading no earlier grant', async () => {
        const calls: string[] = [];
        const requestPersist = toBrowserStoragePersistRequest({
            persisted: async () => {
                calls.push('persisted');
                return false;
            },
            persist: async () => {
                calls.push('persist');
                return false;
            }
        });

        await expect(requestPersist?.()).resolves.toBe(false);
        expect(calls).toEqual(['persisted', 'persist']);
    });

    it('asks through the browser storage manager where it has persist', async () => {
        const persist = vi.fn(async () => true);

        const requestPersist = toBrowserStoragePersistRequest({ persist });

        expect(toBrowserStoragePersistRequest(undefined)).toBeUndefined();
        expect(toBrowserStoragePersistRequest({})).toBeUndefined();
        await expect(requestPersist?.()).resolves.toBe(true);
        expect(persist).toHaveBeenCalledTimes(1);
    });
});

function createStorageAvailability(
    initial: ALStorageAvailability,
    requestPersist: BrowserStoragePersistRequest,
    storage: (event: ALStorageEvent) => void
): BrowserALStorageAvailability {
    return new BrowserALStorageAvailability({ initial, requestPersist, storage });
}

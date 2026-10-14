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
import type { ALStorageEvent, ALStorageHealthStatus } from '@shared/alm/storage/al-storage-event.ts';
import { toALStorageUnavailable, type ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
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

    // A listener of the availability fires on a new value, so an unchanged one must stay the same value.
    it('keeps the same availability when a durable admission finds storage already available', () => {
        expect(computeALStorageAvailability(AVAILABLE, { kind: 'admitted', durable: true, queuedAttempts: 1 })).toBe(AVAILABLE);
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

    it('logs a storage sink that throws on the persist outcome instead of leaving the rejection unhandled', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const storage = createStorageAvailability(AVAILABLE, async () => true, () => {
                throw new Error('sink failed');
            });

            storage.requestPersistentStorage();

            await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'sink failed' })));
        }
        finally {
            consoleError.mockRestore();
        }
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

describe('the checkpoint lane a connect may skip', () => {
    it('skips nothing while storage is available and every checkpoint store keeps up', () => {
        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});

        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'delayed', undefined));

        expect(storage.getCheckpointLaneSkip()).toBeUndefined();
    });

    it('skips it while storage is missing, as it skips the durable lane', () => {
        const storage = createStorageAvailability(MISSING, undefined, () => {});

        expect(storage.getCheckpointLaneSkip()).toEqual({ cause: 'missing', detail: 'No IndexedDB.' });
    });

    it('skips it while a checkpoint store lags beyond its bound, until that store is healthy again', () => {
        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});

        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', CHECKPOINT_LAG));
        const lagging = storage.getCheckpointLaneSkip();
        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'healthy', CHECKPOINT_LAG));

        expect(lagging).toEqual(CHECKPOINT_LAG);
        expect(storage.getCheckpointLaneSkip()).toBeUndefined();
    });

    // Each carrier has its own checkpoint store: one catching up leaves the other's lag standing.
    it('keeps one store\'s lag while another store recovers', () => {
        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});

        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', CHECKPOINT_LAG));
        storage.recordCheckpointHealth(toCheckpointHealth(RTC_CHECKPOINT, 'healthy', undefined));

        expect(storage.getCheckpointLaneSkip()).toEqual(CHECKPOINT_LAG);
    });

    // A store already failing (a restore it could not read, an evicted database) states no later lag, so any
    // failing checkpoint store skips the lane; `delayed` is a checkpoint that is late, not one that is lost.
    it('skips it while a checkpoint store fails for any cause, until that store reads delayed or healthy', () => {
        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});

        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', QUOTA_FAILURE));
        const failing = storage.getCheckpointLaneSkip();
        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'delayed', QUOTA_FAILURE));
        const delayed = storage.getCheckpointLaneSkip();
        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', QUOTA_FAILURE));
        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'healthy', QUOTA_FAILURE));

        expect(failing).toEqual(QUOTA_FAILURE);
        expect(delayed).toBeUndefined();
        expect(storage.getCheckpointLaneSkip()).toBeUndefined();
    });

    it('names a failing store that carries no failure as transaction-failed', () => {
        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});

        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', undefined));

        expect(storage.getCheckpointLaneSkip()).toEqual({ cause: 'transaction-failed', detail: expect.stringContaining(WS_CHECKPOINT) });
    });

    it('skips nothing for an event that is no health', () => {
        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});

        storage.recordCheckpointHealth({ kind: 'persist', outcome: 'granted' });

        expect(storage.getCheckpointLaneSkip()).toBeUndefined();
    });

    it('leaves the durable lane to its own availability', () => {
        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});

        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', CHECKPOINT_LAG));

        expect(storage.getDurableLaneSkip()).toBeUndefined();
        expect(storage.availability.get()).toEqual(AVAILABLE);
    });
});

const WS_CHECKPOINT = 'browser-ws-client-checkpoint:session-1';
const RTC_CHECKPOINT = 'browser-rtc-overlay-checkpoint:session-1';
const CHECKPOINT_LAG = { cause: 'checkpoint-lag', detail: 'unsaved for 12000 ms' } as const;
const QUOTA_FAILURE = { cause: 'quota', detail: 'QuotaExceededError' } as const;

function toCheckpointHealth(
    storeId: string,
    status: ALStorageHealthStatus,
    lastFailure: ALStorageUnavailable | undefined
): ALStorageEvent {
    return {
        kind: 'health',
        storeId,
        status,
        lastFailure,
        lastRecoveryPointAtMs: undefined,
        oldestUnsavedAgeMs: status === 'healthy' ? undefined : 12_000
    };
}

function createStorageAvailability(
    initial: ALStorageAvailability,
    requestPersist: BrowserStoragePersistRequest,
    storage: (event: ALStorageEvent) => void
): BrowserALStorageAvailability {
    return new BrowserALStorageAvailability({ initial, requestPersist, storage });
}

import '../../setup-browser-indexeddb.ts';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
    toBrowserWsClientALCheckpointRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts';
import {
    resolveBrowserALCheckpointSettings,
    resolveBrowserALCheckpointStores
} from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

const SCOPE = defaultStateScope();
const QUOTA = new DOMException('full', 'QuotaExceededError');

describe('the browser checkpoint settings', () => {
    it('defaults to a 1 s interval target and a 10 s recovery-lag bound', () => {
        expect(resolveBrowserALCheckpointSettings({})).toEqual({ intervalMs: 1_000, lagBoundMs: 10_000 });
    });

    it('takes the settings the composition states', () => {
        expect(resolveBrowserALCheckpointSettings({ checkpointIntervalMs: 250, checkpointLagBoundMs: 2_000 }))
            .toEqual({ intervalMs: 250, lagBoundMs: 2_000 });
    });
});

describe('the checkpoint stores of a browser connect', () => {
    it('gives each outbound carrier its own memory pair under its checkpoint store id', () => {
        const sessionId = `checkpoint-pairs-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });

        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        expect(stores.wsClient.workQueue).toBeInstanceOf(InMemoryQueueBox);
        expect(stores.rtcOverlay.workQueue).toBeInstanceOf(InMemoryQueueBox);
        expect(stores.wsClient.workQueue).not.toBe(stores.rtcOverlay.workQueue);
        expect(stores.wsClient.admissionStore.namespace).toBe(
            `browser:${toBrowserWsClientALCheckpointRuntimeStoreId(sessionId)}:outbound:admission`
        );
        expect(stores.rtcOverlay.admissionStore.namespace).toBe(
            `browser:${toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)}:outbound:admission`
        );
    });

    it('states each checkpoint store\'s lag under its own id, apart from the durable store of its carrier', async () => {
        const events: ALStorageEvent[] = [];
        const sessionId = `checkpoint-health-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: toRallarDiagnosticsPorts({
                storage: (event) => events.push(event),
                indexedDbOperationObserver: refuseWritesWhile({ refusing: true })
            }),
            ...FAST_CHECKPOINTS
        });
        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        await stores.wsClient.workQueue.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(createMessage(), 'outbox'));

        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ status: 'failing' })));
        expect(events).toEqual([
            expect.objectContaining({
                kind: 'health',
                storeId: toBrowserWsClientALCheckpointRuntimeStoreId(sessionId),
                status: 'delayed'
            }),
            expect.objectContaining({
                kind: 'health',
                storeId: toBrowserWsClientALCheckpointRuntimeStoreId(sessionId),
                status: 'failing',
                lastFailure: expect.objectContaining({ cause: 'checkpoint-lag' })
            })
        ]);
    });

    // A store's health reaches its sinks on the next turn, so each step waits for the event it states.
    it('skips the connect\'s checkpoint lane while one of its checkpoint stores lags, until it is healthy again', async () => {
        const events: ALStorageEvent[] = [];
        const writes = { refusing: false };
        const sessionId = `checkpoint-lag-${crypto.randomUUID()}`;
        const storage = configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: toRallarDiagnosticsPorts({
                storage: (event) => events.push(event),
                indexedDbOperationObserver: refuseWritesWhile(writes)
            }),
            ...FAST_CHECKPOINTS
        });
        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        resolveBrowserWsClientALOutboundRuntimeStores(sessionId).storageHealth?.recordFailure({
            cause: 'quota',
            detail: 'QuotaExceededError'
        });
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(storage.getCheckpointLaneSkip()).toBeUndefined();

        writes.refusing = true;
        await stores.rtcOverlay.workQueue.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(createMessage(), 'outbox'));
        await vi.waitFor(() => expect(storage.getCheckpointLaneSkip()).toMatchObject({ cause: 'checkpoint-lag' }));

        writes.refusing = false;
        await vi.waitFor(() => expect(storage.getCheckpointLaneSkip()).toBeUndefined());
    });

    // The clock is fake too: the timer is armed for the change's age, which a real clock can move by a millisecond.
    it('writes a checkpoint at the interval the composition states, in one IndexedDB write', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const observer = createCountingIndexedDbOperationObserver();
        const sessionId = `checkpoint-interval-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: toRallarDiagnosticsPorts({ indexedDbOperationObserver: observer }),
            checkpointIntervalMs: 250
        });
        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        await stores.wsClient.workQueue.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(createMessage(), 'outbox'));
        vi.advanceTimersByTime(249);
        const beforeInterval = observer.getCounts().total;
        vi.advanceTimersByTime(1);
        vi.useRealTimers();

        expect(beforeInterval).toBe(0);
        await vi.waitFor(() => expect(observer.getCounts().byKind.write).toBe(1));
        expect(observer.getCounts().total).toBe(1);
    });
});

/** Settings short enough that a refused checkpoint passes its lag bound within a wait. */
const FAST_CHECKPOINTS = { checkpointIntervalMs: 20, checkpointLagBoundMs: 100 } as const;

/** Fails every IndexedDB write as a full quota would, while `refusing` holds. */
function refuseWritesWhile(writes: { readonly refusing: boolean; }): IndexedDbOperationObserver {
    return {
        observe: (operation) => writes.refusing && operation.kind === 'write' ? Promise.reject(QUOTA) : undefined
    };
}

function disposeCheckpoints(stores: ReturnType<typeof resolveBrowserALCheckpointStores>): void {
    stores.wsClient.checkpoint.dispose();
    stores.rtcOverlay.checkpoint.dispose();
}

function createMessage() {
    return newALUnicastMessage(
        'session-1',
        { topicId: 'chat', resourceId: 'checkpoint', contextId: 'conversation' },
        'peer',
        'chat.message.v1',
        { text: 'checkpoint' },
        { ttlMs: 30_000 }
    );
}

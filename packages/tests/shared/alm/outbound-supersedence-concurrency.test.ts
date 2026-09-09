import '../../setup-browser-indexeddb.ts';
import {
    claimOutboundTestWork,
    createOutboundCanonicalEntry,
    releaseOutboundTestWork
} from './outbound-runtime-test-fixture.ts';

import {
    describe,
    expect,
    it
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { createOutboundMessage } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound shared supersedence decisions', () => {
    it.each(
        [
            { storage: 'memory', populated: false },
            { storage: 'memory', populated: true },
            { storage: 'indexeddb', populated: false },
            { storage: 'indexeddb', populated: true }
        ] as const
    )('rejects a stale $storage decision after another sender changes the original observation (populated: $populated)', async ({ storage, populated }) => {
        const stores = createStore(storage);
        const store = stores.admissionStore;
        if (populated) {
            const seed = await readDecision(store, createMessage('seed', 0));
            expect(await store.commitBundle(seed.bundle!)).toBe('committed');
            for (const work of await claimOutboundTestWork(stores, 10)) {
                await releaseOutboundTestWork(stores, work.entry, { status: 'completed' });
            }
        }
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const oldDecision = await readDecision(store, older);
        const newDecision = await readDecision(store, newer);
        expect(oldDecision.status).toBe('accepted');
        expect(newDecision.status).toBe('accepted');

        expect(await store.commitBundle(newDecision.bundle!)).toBe('committed');
        expect(await store.commitBundle(oldDecision.bundle!)).toBe('conflict');
        expect(await store.readSentMessage(older.id.msgId)).toBeUndefined();
        const effects = await claimOutboundTestWork(stores, 10);
        expect(effects.map((effect) => effect.payload.kind === 'send-prepared' ? effect.payload.message.msgId : '')).toEqual([newer.id.msgId]);

        const refreshed = await readDecision(store, older);
        expect(refreshed.status).toBe('superseded');
        expect(refreshed.bundle).toBeUndefined();
        expect(JSON.stringify((await store.readSentMessage(newer.id.msgId))?.msg)).toBe(JSON.stringify(newer));
    });

    it.each(['memory', 'indexeddb'] as const)('allows independent %s work and a newer message recomputed after conflict', async (storage) => {
        const stores = createStore(storage);
        const store = stores.admissionStore;
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const other = createMessage('sender-c', 3);
        const oldDecision = await readDecision(store, older);
        const newDecision = await readDecision(store, newer);
        const otherDecision = await readDecision(store, other, 'other-topic');

        expect(await store.commitBundle(oldDecision.bundle!)).toBe('committed');
        expect(await store.commitBundle(otherDecision.bundle!)).toBe('committed');
        expect(await store.commitBundle(newDecision.bundle!)).toBe('conflict');
        const retry = await readDecision(store, newer);
        expect(await store.commitBundle(retry.bundle!)).toBe('committed');
        const latest = await store.readOutgoingMessage({
            msg: createMessage('observer', 4),
            planner: (message) => ({
                msg: message,
                persist: false,
                preparedMessages: [],
                supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        expect(latest.supersedence.latest?.latestMsgId).toBe(newer.id.msgId);
        expect(JSON.stringify((await store.readSentMessage(other.id.msgId))?.msg)).toBe(JSON.stringify(other));
    });
});

function createStore(storage: 'memory' | 'indexeddb') {
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({
            dbName: `supersedence-${crypto.randomUUID()}`,
            storeName: 'admission',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'outbound',
            decodePrepared: decodeOutboundTestPayload,
            namespace: 'outbound',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}

function createMessage(senderId: string, sequence: number): ALMessage {
    const message = createOutboundMessage(`message-${sequence}`);
    return { ...message, id: { ...message.id, senderId }, ordering: { orderingKey: 'shared-topic', seq: sequence } };
}

async function readDecision(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage,
    supersedenceKey = 'shared-topic'
) {
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: () => ({
            msg: message,
            persist: false,
            preparedMessages: [{ text: message.id.msgId }],
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: supersedenceKey }
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(store, read.msg),
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
}

import '../../setup-browser-indexeddb.ts';

import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';

import { createOutboundMessage } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound shared supersedence decisions', () => {
    it.each(
        [
            { storage: 'memory', populated: false },
            { storage: 'memory', populated: true },
            { storage: 'indexeddb', populated: false },
            { storage: 'indexeddb', populated: true }
        ] as const
    )('rejects a stale $storage decision after another sender changes the original observation (populated: $populated)', async ({ storage, populated }) => {
        const store = createStore(storage);
        if (populated) {
            const seed = await readDecision(store, createMessage('seed', 0));
            expect(await store.commitBundle(seed.bundle!, decodeOutboundTestPayload)).toBe('committed');
            for (const effect of await store.claimReadyEffects({ maxCount: 10 }, decodeOutboundTestPayload)) {
                await store.completeEffect(effect.entry);
            }
        }
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const oldDecision = await readDecision(store, older);
        const newDecision = await readDecision(store, newer);
        expect(oldDecision.status).toBe('accepted');
        expect(newDecision.status).toBe('accepted');

        expect(await store.commitBundle(newDecision.bundle!, decodeOutboundTestPayload)).toBe('committed');
        expect(await store.commitBundle(oldDecision.bundle!, decodeOutboundTestPayload)).toBe('conflict');
        expect(await store.getSentMessage(older.id.msgId)).toBeUndefined();
        const effects = await store.claimReadyEffects({ maxCount: 10 }, decodeOutboundTestPayload);
        expect(effects.map((effect) => effect.payload.kind === 'send-prepared' ? effect.payload.msg.id.msgId : '')).toEqual([newer.id.msgId]);

        const refreshed = await readDecision(store, older);
        expect(refreshed.status).toBe('superseded');
        expect(refreshed.bundle).toBeUndefined();
        expect(await store.getSentMessage(newer.id.msgId)).toMatchObject({ msg: newer });
    });

    it.each(['memory', 'indexeddb'] as const)('allows independent %s work and a newer message recomputed after conflict', async (storage) => {
        const store = createStore(storage);
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const other = createMessage('sender-c', 3);
        const oldDecision = await readDecision(store, older);
        const newDecision = await readDecision(store, newer);
        const otherDecision = await readDecision(store, other, 'other-topic');

        expect(await store.commitBundle(oldDecision.bundle!, decodeOutboundTestPayload)).toBe('committed');
        expect(await store.commitBundle(otherDecision.bundle!, decodeOutboundTestPayload)).toBe('committed');
        expect(await store.commitBundle(newDecision.bundle!, decodeOutboundTestPayload)).toBe('conflict');
        const retry = await readDecision(store, newer);
        expect(await store.commitBundle(retry.bundle!, decodeOutboundTestPayload)).toBe('committed');
        const latest = await store.readOutgoingMessage(createMessage('observer', 4), () => ({
            persist: false,
            preparedMessages: [],
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
        }));
        expect(latest.supersedence.latest?.latestMsgId).toBe(newer.id.msgId);
        expect(await store.getSentMessage(other.id.msgId)).toMatchObject({ msg: other });
    });
});

function createStore(storage: 'memory' | 'indexeddb') {
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend(`supersedence-${crypto.randomUUID()}`, 'admission', Date.now);
    return createALOutboundAdmissionStore({
        namespace: 'outbound',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
}

function createMessage(senderId: string, sequence: number): ALMessage {
    const message = createOutboundMessage(`message-${sequence}`);
    return { ...message, id: { ...message.id, senderId }, ordering: { orderingKey: 'shared-topic', seq: sequence } };
}

async function readDecision(store: ALOutboundAdmissionStore, message: ALMessage, supersedenceKey = 'shared-topic') {
    const read = await store.readOutgoingMessage(message, () => ({
        persist: false,
        preparedMessages: [{ text: message.id.msgId }],
        supersedenceTracking: { enabled: true, algo: 'latest-wins', key: supersedenceKey }
    }));
    return computeALOutboundDispatch({
        read,
        outboxEntry: undefined,
        canFallback: false,
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
}

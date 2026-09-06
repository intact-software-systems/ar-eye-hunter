// @vitest-environment happy-dom

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import '../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createFlakyOutboundAdmissionStore,
    createOutboundMessage,
    reserveOutbox
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound IndexedDB durable queue replay', () => {
    it.each(['memory', 'indexeddb'] as const)('fences old completion and retry after the same worker reclaims an effect in %s', async (storage) => {
        const { store } = createAdmission(storage);
        const msg = createOutboundMessage('lease-fence');
        const nowMs = Date.now();
        await store.commitBundle({
            senderId: msg.id.senderId,
            mutations: [],
            durableEffects: [{ effectId: 'lease-fence', retryAtMs: nowMs, payload: { kind: 'ack-timeout', msgId: msg.id.msgId } }]
        }, decodeOutboundTestPayload);
        const [oldClaim] = await store.claimReadyEffects(
            { workerId: 'same-worker', maxCount: 1, leaseMs: 100, nowMs },
            decodeOutboundTestPayload
        );
        const [newClaim] = await store.claimReadyEffects(
            { workerId: 'same-worker', maxCount: 1, leaseMs: 100, nowMs: nowMs + 100 },
            decodeOutboundTestPayload
        );

        await store.completeEffect(oldClaim.effectId, oldClaim.leaseOwner, decodeOutboundTestPayload);
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(newClaim.leaseUntilMs);
        await store.rescheduleEffect({
            effectId: oldClaim.effectId,
            leaseOwner: oldClaim.leaseOwner,
            retryAtMs: nowMs + 5_000,
            lastError: 'Late failure from the previous claim'
        }, decodeOutboundTestPayload);
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(newClaim.leaseUntilMs);
        await store.completeEffect(newClaim.effectId, newClaim.leaseOwner, decodeOutboundTestPayload);
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
    });

    it('keeps Temporal entry values across persistence, lease, reschedule and runtime restart', async () => {
        const { store } = createAdmission();
        const msg = createOutboundMessage('queued');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores: { admissionStore: createFlakyOutboundAdmissionStore(store, { claimReadyEffects: async () => [] }) },
            planOutgoingMessage: () => ({ persist: true, preparedMessages: [] }),
            sendPreparedMessage: async () => {
                throw new Error('No transport effect was planned');
            }
        });
        const enqueued = await runtime1.enqueueIfAbsent(msg);
        runtime1.dispose();

        const [claimed] = await store.claimReadyEffects(
            { workerId: 'stopped-worker', maxCount: 1, leaseMs: 100, nowMs: Date.now() },
            decodeOutboundTestPayload
        );
        expect(claimed.payload.kind).toBe('enqueue-outbox');
        await store.rescheduleEffect(
            { effectId: claimed.effectId, leaseOwner: claimed.leaseOwner, retryAtMs: Date.now(), lastError: 'restart' },
            decodeOutboundTestPayload
        );

        const outbox = new InMemoryQueueBox(new Map());
        const runtime2 = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            outbox,
            planOutgoingMessage: () => {
                throw new Error('Saved queue effect must not replan');
            },
            sendPreparedMessage: async () => {
                throw new Error('Saved queue effect must not send');
            }
        });
        await runtime2.ready();
        const [replayed] = await reserveOutbox(outbox);
        expect(replayed.audit.date).toBeInstanceOf(Temporal.PlainTime);
        expect(replayed.audit.createdTs).toBeInstanceOf(Temporal.PlainDateTime);
        expect(replayed.audit.expiryTs).toBeInstanceOf(Temporal.Instant);
        expect(replayed.audit.expiryTs.toString()).toBe(enqueued.entry?.audit.expiryTs.toString());
        expect(replayed.resource).toBe(JSON.stringify(msg));
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
    });

    it('keeps fallback entry timestamps across a persisted lease and rejects old empty timestamp objects', async () => {
        const { backend, store } = createAdmission();
        const msg = createOutboundMessage('fallback');
        const originalEntry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        const timestamp = Temporal.Now.instant();
        const entry = {
            ...originalEntry,
            dequeueAudit: { ...originalEntry.dequeueAudit, startTs: timestamp, endTs: timestamp, nextTs: timestamp }
        };
        await store.commitBundle({
            senderId: msg.id.senderId,
            mutations: [],
            durableEffects: [{ effectId: 'fallback', payload: { kind: 'fallback-dispatch', msg, entry } }]
        }, decodeOutboundTestPayload);
        const [claimed] = await store.claimReadyEffects({ workerId: 'worker', maxCount: 1, leaseMs: 100, nowMs: Date.now() }, decodeOutboundTestPayload);
        if (claimed.payload.kind !== 'fallback-dispatch') {
            throw new Error('Expected the durable fallback effect');
        }
        expect(claimed.payload.entry.dequeueAudit.startTs?.toString()).toBe(timestamp.toString());
        expect(claimed.payload.entry.dequeueAudit.endTs?.toString()).toBe(timestamp.toString());
        expect(claimed.payload.entry.dequeueAudit.nextTs?.toString()).toBe(timestamp.toString());
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(claimed.leaseUntilMs);
        await store.completeEffect(claimed.effectId, claimed.leaseOwner, decodeOutboundTestPayload);

        await backend.write(async (tx) => {
            await tx.set('outbound:effect:fallback', {
                ...claimed,
                payload: { kind: 'fallback-dispatch', msg, entry: { ...entry, audit: { ...entry.audit, expiryTs: {} } } }
            });
        });
        await expect(store.peekNextEffectReadyAt(decodeOutboundTestPayload)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });
});

function createAdmission(storage: 'memory' | 'indexeddb' = 'indexeddb') {
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend(`outbound-replay-${crypto.randomUUID()}`, 'admission', Date.now);
    const store = createALOutboundAdmissionStore({
        namespace: 'outbound',
        backend,
        supersedenceTrackTtlMs: 1_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { backend, store };
}

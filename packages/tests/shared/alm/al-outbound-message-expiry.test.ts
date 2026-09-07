import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import { validateALOutboundDispatch } from '@shared/alm/outbound/validate-al-outbound-dispatch.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultOutboundTestAdmissionStore, createOutboundMessage } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound message expiry', () => {
    afterEach(() => vi.useRealTimers());

    it('replaces superseded raw freshness before preparing the frame and work', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const original: ALMessage = {
            ...createOutboundMessage('downgrade'),
            constraints: undefined,
            qos: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } }
        };
        const before = JSON.stringify(original);
        const effective = normalizeALQosPolicy(original, { capabilities: { supportedExpiry: ['ttl-only'] } }).effective;
        const msg = toALOutboundMessage(original, effective);
        expect(msg.constraints?.expiresAtMs).toBe(31_000);
        expect(msg.qos?.expiry?.algo).toBe('ttl-only');
        vi.setSystemTime(2_000);
        const store = createDefaultOutboundTestAdmissionStore();
        const read = await store.readOutgoingMessage(original, () => ({ msg, persist: false, preparedMessages: [{ message: JSON.stringify(msg) }] }));
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: undefined,
            canFallback: false,
            dispatchAtMs: 2_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        expect(validateALOutboundDispatch(read, candidate).right).toBe(candidate);
        expect(await store.commitBundle(candidate.bundle!, decodeOutboundTestPayload)).toBe('committed');
        const [work] = await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload);
        expect(work.expireAtTimestamp).toBe(31_000);
        expect(work.payload).toMatchObject({ msg: JSON.parse(JSON.stringify(msg)), prepared: { message: JSON.stringify(msg) } });
        expect(JSON.stringify(original)).toBe(before);
    });

    it('captures topic freshness and preserves its deadline after policy changes', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const original = { ...createOutboundMessage('topic-freshness'), constraints: undefined };
        const selected = normalizeALQosPolicy(original, {
            defaults: {
                expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 500 } }
            }
        }).effective;
        const msg = toALOutboundMessage(original, selected);
        expect(msg.constraints?.expiresAtMs).toBe(1_500);
        const changed = normalizeALQosPolicy(msg, { capabilities: { supportedExpiry: ['ttl-only'] } }).effective;
        vi.setSystemTime(1_400);
        expect(toALOutboundMessage(msg, changed).constraints?.expiresAtMs).toBe(1_500);
        expect(original.constraints).toBeUndefined();
    });

    it.each([500, 60_000])('keeps an explicit finite %sms caller lifetime', (ttlMs) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const original = createOutboundMessage('caller-lifetime', { ttlMs });
        const msg = toALOutboundMessage(original, normalizeALQosPolicy(original).effective);
        expect(msg.constraints?.expiresAtMs).toBe(1_000 + ttlMs);
    });

    it('returns expiry at commit without installing partial message state or queue work', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const store = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('commit-expiry', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage(msg, () => ({ msg, persist: false, preparedMessages: [{ message: JSON.stringify(msg) }] }));
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: undefined,
            canFallback: false,
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        const before = JSON.stringify(candidate);
        vi.setSystemTime(2_000);
        expect(await store.commitBundle(candidate.bundle!, decodeOutboundTestPayload)).toBe('expired');
        expect(await store.getSentMessage(msg.id.msgId)).toBeUndefined();
        expect(await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload)).toEqual([]);
        expect(JSON.stringify(candidate)).toBe(before);
    });

    it('rechecks expiry after waiting for the backend without decoding or staging work inside the writer', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const state = createInMemoryALAdmissionState();
        const backend = new InMemoryAdmissionBackend(state, Date.now);
        const store = createALOutboundAdmissionStore({
            backend,
            namespace: 'held-writer',
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const msg = createOutboundMessage('held-expiry', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage(msg, () => ({ msg, persist: false, preparedMessages: [{ message: JSON.stringify(msg) }] }));
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: undefined,
            canFallback: false,
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const write = backend.write.bind(backend);
        let insideWriter = false;
        const decoderObservations: boolean[] = [];
        backend.write = async (operation) => {
            entered.resolve();
            await release.promise;
            insideWriter = true;
            try {
                return await write(operation);
            }
            finally {
                insideWriter = false;
            }
        };
        const committed = store.commitBundle(candidate.bundle!, (value) => {
            decoderObservations.push(insideWriter);
            return decodeOutboundTestPayload(value);
        });
        await entered.promise;
        vi.setSystemTime(2_000);
        release.resolve();
        expect(await committed).toBe('expired');
        expect(decoderObservations).toEqual([false]);
        expect(await store.getSentMessage(msg.id.msgId)).toBeUndefined();
        expect(await backend.workQueue.getAllKeys()).toEqual([]);
        expect(state.data.size).toBe(0);
    });

    it('rejects a RESERVED observation without a start timestamp while valid siblings remain claimable', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const state = createInMemoryALAdmissionState();
        const backend = new InMemoryAdmissionBackend(state, Date.now);
        const store = createALOutboundAdmissionStore({
            backend,
            namespace: 'malformed-reservation',
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        for (const name of ['malformed', 'valid']) {
            const msg = createOutboundMessage(name);
            const read = await store.readOutgoingMessage(msg, () => ({ msg, persist: false, preparedMessages: [{ message: JSON.stringify(msg) }] }));
            const candidate = computeALOutboundDispatch({
                read,
                outboxEntry: undefined,
                canFallback: false,
                dispatchAtMs: 1_000,
                intent: 'enqueue',
                phase: 'immediate',
                options: {}
            });
            await store.commitBundle(candidate.bundle!, decodeOutboundTestPayload);
        }
        const [reserved] = await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload);
        const malformed = { ...reserved.entry, dequeueAudit: { ...reserved.entry.dequeueAudit, startTs: undefined } };
        await backend.workQueue.setItem(malformed.key, malformed, { expireAtTimestamp: reserved.expireAtTimestamp });
        expect(await store.peekNextEffectReadyAt()).toBe(1_000);
        expect(await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload)).toHaveLength(1);
        expect(await backend.workQueue.getItem(malformed.key)).toMatchObject({ status: EntityStatus.NON_RETRYABLE });
    });

    it.each(['expires-at', 'fresh-until'] as const)('bounds persisted transport work by the original %s deadline', async (algo) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const store = createDefaultOutboundTestAdmissionStore();
        const msg: ALMessage = Object.freeze({
            ...createOutboundMessage('bounded-work', { ttlMs: 10_000 }),
            qos: Object.freeze({
                expiry: Object.freeze({
                    algo,
                    opts: Object.freeze(algo === 'expires-at' ? { expiresAtMs: 2_000 } : { maxStalenessMs: 1_000 })
                })
            })
        });
        const plan: ALOutboundDispatchPlan<OutboundTestPayload> = {
            msg: msg,
            persist: false,
            preparedMessages: [{ message: JSON.stringify(msg) }]
        };
        const read = await store.readOutgoingMessage(msg, () => plan);
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: undefined,
            canFallback: false,
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        const before = JSON.stringify({ read, candidate });
        expect(validateALOutboundDispatch(read, candidate).right).toBe(candidate);
        expect(candidate.status).toBe('accepted');
        expect(candidate.bundle?.durableEffects.map((effect) => effect.expireAtTimestamp)).toEqual([2_000]);
        if (!candidate.bundle) {
            throw new Error('Accepted transport work requires an admission bundle');
        }
        Object.freeze(candidate.bundle);
        expect(await store.commitBundle(candidate.bundle, decodeOutboundTestPayload)).toBe('committed');
        expect(JSON.stringify({ read, candidate })).toBe(before);

        vi.setSystemTime(1_999);
        expect(await store.getSentMessage(msg.id.msgId)).toBeDefined();
        vi.setSystemTime(2_000);
        expect(await store.claimReadyEffects({ maxCount: 10 }, decodeOutboundTestPayload)).toEqual([]);
        expect(await store.getSentMessage(msg.id.msgId)).toBeUndefined();
    });

    it.each(['enqueue', 'dequeue', 'repair'] as const)('rejects expiry during the admission read before %s can create work', async (intent) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const store = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('expired-read', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage<OutboundTestPayload>(msg, () => ({
            msg: msg,
            persist: false,
            preparedMessages: [{ message: JSON.stringify(msg) }]
        }));
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: undefined,
            canFallback: false,
            dispatchAtMs: 2_000,
            intent,
            phase: 'immediate',
            options: {}
        });
        expect(candidate).toMatchObject({ status: 'expired', reason: 'Message expired or is too stale', entries: [] });
        expect(validateALOutboundDispatch(read, candidate).right).toBe(candidate);
    });

    it.each(['enqueue-outbox', 'fallback-dispatch'] as const)('uses the same expiry for %s and the QueueBox entry', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const store = createDefaultOutboundTestAdmissionStore();
        const msg: ALMessage = {
            ...createOutboundMessage('queued-work', { ttlMs: 10_000 }),
            qos: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } }
        };
        const read = await store.readOutgoingMessage<OutboundTestPayload>(msg, () => ({
            msg: msg,
            persist: kind === 'enqueue-outbox',
            preparedMessages: []
        }));
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: entry,
            canFallback: true,
            dispatchAtMs: 1_000,
            intent: kind === 'enqueue-outbox' ? 'enqueue' : 'dequeue',
            phase: 'immediate',
            options: {}
        });
        expect(entry.audit.expiryTs.epochMilliseconds).toBe(2_000);
        expect(candidate.bundle?.durableEffects).toHaveLength(1);
        expect(candidate.bundle?.durableEffects[0]).toMatchObject({ expireAtTimestamp: 2_000, payload: { kind, msg, entry } });
        expect(validateALOutboundDispatch(read, candidate).right).toBe(candidate);
    });

    it.each([undefined, 3_000])('rejects a transport-work deadline of %s that would remove or extend the message bound', async (expireAtTimestamp) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const store = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('invalid-work-expiry', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage<OutboundTestPayload>(msg, () => ({
            msg: msg,
            persist: false,
            preparedMessages: [{ message: JSON.stringify(msg) }]
        }));
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: undefined,
            canFallback: false,
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        if (!candidate.bundle) {
            throw new Error('Accepted transport work requires an admission bundle');
        }
        const invalid = {
            ...candidate,
            bundle: {
                ...candidate.bundle,
                durableEffects: candidate.bundle.durableEffects.map((effect) => ({ ...effect, expireAtTimestamp }))
            }
        };
        expect(validateALOutboundDispatch(read, invalid).left).toMatchObject({ code: 'malformed' });
    });
});

import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundRepairAdmission } from '@shared/alm/outbound/al-outbound-repair-admission.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import { validateALOutboundDispatch } from '@shared/alm/outbound/validate-al-outbound-dispatch.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { RetryableConflictError } from '@shared/resilience/TryWith.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    claimOutboundTestWork,
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundCanonicalEntry,
    createOutboundMessage,
    peekOutboundWorkReadyAt
} from './outbound-runtime-test-fixture.ts';
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
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const read = await store.readOutgoingMessage({
            msg: original,
            planner: () => ({ msg, persist: false, preparedMessages: [{ message: JSON.stringify(msg) }] }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: 2_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        expect(validateALOutboundDispatch(read, candidate).left).toBeUndefined();
        expect(await store.commitBundle(candidate.bundle!)).toBe('committed');
        const [work] = await claimOutboundTestWork(stores, 1);
        expect(work.expireAtTimestamp).toBe(31_000);
        expect(work.canonicalMessage).toEqual(JSON.parse(JSON.stringify(msg)));
        expect(work.payload).toMatchObject({ prepared: { message: JSON.stringify(msg) } });
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

    it.each([0, 1])('returns expiry at commit without partial state with %s prepared actions', async (preparedCount) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const msg = createOutboundMessage('commit-expiry', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage({
            msg: msg,
            planner: () => ({ msg, persist: true, preparedMessages: Array.from({ length: preparedCount }, () => ({ peer: 'captured' })) }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        const before = JSON.stringify(candidate);
        vi.setSystemTime(2_000);
        expect(await store.commitBundle(candidate.bundle!)).toBe('expired');
        expect(await store.readSentMessage(msg.id.msgId)).toBeUndefined();
        expect(await claimOutboundTestWork(stores, 1)).toEqual([]);
        expect(JSON.stringify(candidate)).toBe(before);
    });

    it.each([0, 1])('rechecks expiry after waiting for the backend with %s prepared actions', async (preparedCount) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const state = createInMemoryALAdmissionState();
        const backend = new InMemoryAdmissionBackend(state, Date.now);
        const decoderObservations: boolean[] = [];
        let insideWriter = false;
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'held-writer',
            decodePrepared: (value) => {
                decoderObservations.push(insideWriter);
                return decodeOutboundTestPayload(value);
            },
            backend,
            namespace: 'held-writer',
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const msg = createOutboundMessage('held-expiry', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage({
            msg: msg,
            planner: () => ({ msg, persist: true, preparedMessages: Array.from({ length: preparedCount }, () => ({ peer: 'captured' })) }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const write = backend.write.bind(backend);
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
        const committed = store.commitBundle(candidate.bundle!);
        await entered.promise;
        vi.setSystemTime(2_000);
        release.resolve();
        expect(await committed).toBe('expired');
        expect(decoderObservations).toEqual(preparedCount === 0 ? [] : [false]);
        expect(await store.readSentMessage(msg.id.msgId)).toBeUndefined();
        expect(await backend.workQueue.getAllKeys()).toEqual([]);
        expect(state.data.size).toBe(0);
    });

    it('retries a conflicting post-deadline acknowledgement cleanup before clearing its retained obligation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('post-deadline-control', { ttlMs: 10 });
        const bundle = await computeOutboundTestAdmission(store, message);
        await store.commitBundle({
            ...bundle,
            mutations: [...bundle.mutations, {
                kind: 'set-pending-ack',
                snapshot: {
                    msgId: message.id.msgId,
                    expectedPeerIds: ['peer-1'],
                    ackedPeerIds: [],
                    timeoutMs: 50,
                    deadlineAtMs: 1_050,
                    attempts: 0,
                    maxAttempts: 1
                }
            }]
        });
        const clock = { nowMs: Date.now };
        const workPort = createTestALOutboundWorkPort({ ...stores, nowMs: Date.now });
        const repair = new ALOutboundRepairAdmission({
            admissionStore: store,
            clock,
            controlAdmission: store.createControlAdmission(workPort, clock),
            planOutgoingMessage: (msg) => ({ msg, persist: false, preparedMessages: [] }),
            planRepairMessage: undefined
        });
        vi.setSystemTime(1_050);
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        const commit = vi.spyOn(store, 'commitBundle').mockResolvedValueOnce('conflict');
        await expect(repair.retryPendingAck(message.id.msgId)).rejects.toBeInstanceOf(RetryableConflictError);
        expect(await store.readPendingAck(message.id.msgId)).toBeDefined();
        await repair.retryPendingAck(message.id.msgId);
        expect(await store.readPendingAck(message.id.msgId)).toBeUndefined();
        commit.mockRestore();
    });

    it('retains the admission fact after payload expiry until sent-message retention ends', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            decodePrepared: decodeOutboundTestPayload,
            canonicalScope: 'post-expiry-admission',
            backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now),
            namespace: 'post-expiry-admission',
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention({
                sentMessageTtlMs: 100,
                controlHistoryTtlMs: 100
            })
        });
        const message = createOutboundMessage('post-expiry-admission', { ttlMs: 10 });
        const bundle = await computeOutboundTestAdmission(store, message);
        expect(await store.commitBundle(bundle)).toBe('committed');

        vi.setSystemTime(1_010);

        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(await store.hasSentMessageAdmission(message.id.msgId)).toBe(true);

        vi.setSystemTime(1_100);

        expect(await store.hasSentMessageAdmission(message.id.msgId)).toBe(false);
    });

    it('rejects a retained admission fact owned by another canonical scope', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const state = createInMemoryALAdmissionState();
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            decodePrepared: decodeOutboundTestPayload,
            backend: new InMemoryAdmissionBackend(state, Date.now),
            canonicalScope: 'current-session',
            namespace: 'scoped-admission',
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const message = createOutboundMessage('foreign-scope-admission');
        const bundle = await computeOutboundTestAdmission(store, message);
        expect(await store.commitBundle(bundle)).toBe('committed');
        const sent = state.data.get(`scoped-admission:sent:${message.id.msgId}`);
        if (sent === undefined) {
            throw new Error('Expected a retained sent-message admission fact');
        }
        const stored = sent.value as ALStoredOutboundMessage;
        state.data.set(sent.key, {
            ...sent,
            value: {
                ...stored,
                reference: { ...stored.reference, scope: 'another-session' }
            }
        });

        await expect(store.hasSentMessageAdmission(message.id.msgId))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a RESERVED observation without a start timestamp while valid siblings remain claimable', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const backend = stores.backend;
        for (const name of ['malformed', 'valid']) {
            const msg = createOutboundMessage(name);
            const read = await store.readOutgoingMessage({
                msg: msg,
                planner: () => ({ msg, persist: false, preparedMessages: [{ message: JSON.stringify(msg) }] }),
                observedCanonicalEntry: undefined,
                intent: 'enqueue'
            });
            const candidate = computeALOutboundDispatch({
                read,
                outboxEntry: createOutboundCanonicalEntry(store, read.msg),
                dispatchAtMs: 1_000,
                intent: 'enqueue',
                phase: 'immediate',
                options: {}
            });
            await store.commitBundle(candidate.bundle!);
        }
        const [reserved] = await claimOutboundTestWork(stores, 1);
        const malformed = { ...reserved!.entry, dequeueAudit: { ...reserved!.entry.dequeueAudit, startTs: undefined } };
        await backend.workQueue.setItem(malformed.key, malformed, { expireAtTimestamp: reserved!.expireAtTimestamp });
        // A reservation no timeout can recover is advertised as due now and claimed by the owner itself.
        expect(await peekOutboundWorkReadyAt(stores.workQueue, store.namespace)).toBe(1_000);
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: (msg) => ({ msg, persist: false, preparedMessages: [] }),
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.message));
                return { status: 'sent' };
            }
        });
        await runtime.ready();
        expect(await backend.workQueue.getItem(malformed.key)).toMatchObject({ status: EntityStatus.NON_RETRYABLE });
        expect(sent).toHaveLength(1);
    });

    it.each(['expires-at', 'fresh-until'] as const)('bounds persisted transport work by the original %s deadline', async (algo) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
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
        const read = await store.readOutgoingMessage({ msg: msg, planner: () => plan, observedCanonicalEntry: undefined, intent: 'enqueue' });
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        const before = JSON.stringify({ read, candidate });
        expect(validateALOutboundDispatch(read, candidate).left).toBeUndefined();
        expect(candidate.status).toBe('accepted');
        expect(candidate.bundle?.durableEffects.map((effect) => effect.expireAtTimestamp)).toEqual([2_000]);
        if (!candidate.bundle) {
            throw new Error('Accepted transport work requires an admission bundle');
        }
        Object.freeze(candidate.bundle);
        expect(await store.commitBundle(candidate.bundle)).toBe('committed');
        expect(JSON.stringify({ read, candidate })).toBe(before);

        vi.setSystemTime(1_999);
        expect(await store.readSentMessage(msg.id.msgId)).toBeDefined();
        vi.setSystemTime(2_000);
        expect(await claimOutboundTestWork(stores, 10)).toEqual([]);
        expect(await store.readSentMessage(msg.id.msgId)).toBeUndefined();
    });

    it.each(['enqueue', 'dequeue', 'repair'] as const)('rejects expiry during the admission read before %s can create work', async (intent) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const msg = createOutboundMessage('expired-read', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage({
            msg: msg,
            planner: () => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ message: JSON.stringify(msg) }]
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: 2_000,
            intent,
            phase: 'immediate',
            options: {}
        });
        expect(candidate).toMatchObject({ status: 'expired', reason: 'Message expired or is too stale', entries: [] });
        expect(validateALOutboundDispatch(read, candidate).left).toBeUndefined();
    });

    it('retains one canonical QueueBox row at its logical deadline before physical expansion', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const msg: ALMessage = {
            ...createOutboundMessage('queued-work', { ttlMs: 10_000 }),
            qos: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } }
        };
        const read = await store.readOutgoingMessage({
            msg: msg,
            planner: () => ({
                msg: msg,
                persist: true,
                preparedMessages: []
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: entry,
            dispatchAtMs: 1_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });
        expect(entry.audit.expiryTs.epochMilliseconds).toBe(2_000);
        expect(candidate.bundle?.durableEffects).toEqual([]);
        expect(candidate.bundle?.canonicalEntry).toEqual(entry);
        expect(validateALOutboundDispatch(read, candidate).left).toBeUndefined();
    });

    it.each([undefined, 3_000])('rejects a transport-work deadline of %s that would remove or extend the message bound', async (expireAtTimestamp) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const msg = createOutboundMessage('invalid-work-expiry', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage({
            msg: msg,
            planner: () => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ message: JSON.stringify(msg) }]
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const candidate = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
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
        expect(validateALOutboundDispatch(read, invalid).left).toContainEqual(expect.objectContaining({ code: 'malformed' }));
    });
});

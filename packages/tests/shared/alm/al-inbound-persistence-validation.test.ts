import {
    createTestALInboundControlAdmission,
    createTestALInboundWorkPort
} from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionWriteContext
} from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALPersistedInboundEffect } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionObservations,
    type ALInboundCommitBundle,
    type ALInboundControlOwnerIndex,
    type ALInboundDurableEffect
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import {
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    toALInboundWorkKey
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import type { ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

const message: ALMessage = {
    id: { v: 2, msgId: 'message', senderId: 'sender:with:delimiter', ts: 1_800_000_000_000 },
    route: { topicId: 'chat', resourceId: 'resource', contextId: 'room' },
    ordering: { orderingKey: 'chat', seq: 2 },
    payload: { typeId: 'chat', resource: '{"text":"hello"}' }
};

function planMessage(candidate: ALMessage) {
    return planALMessageHandling(candidate, { selfPeerId: 'receiver', nowMs: Date.now() });
}

function createFixture() {
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const store = createALInboundAdmissionStore({
        namespace: 'inbound',
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const stores = { admissionStore: store, workQueue: state.workQueue };
    return {
        state,
        backend,
        store,
        workQueue: state.workQueue,
        port: createTestALInboundWorkPort({ ...stores, nowMs: Date.now }),
        control: createTestALInboundControlAdmission({
            ...stores,
            nowMs: Date.now,
            newControlId: () => 'generated-control'
        })
    };
}

function readIncoming(store: ReturnType<typeof createFixture>['store'], candidate: ALMessage) {
    const source = { kind: 'ws-client' as const, peerId: candidate.id.senderId };
    const nowMs = Date.now();
    return store.readIncomingMessage({
        msg: candidate,
        source,
        nowMs,
        prePlan: planMessage(candidate)
    });
}

function createBufferedSnapshot() {
    return {
        trackKey: toALOrderingTrackKey(message)!,
        seq: 2,
        message: toMessageReference(message),
        plan: planMessage(message)
    };
}

function toMessageReference(candidate: ALMessage) {
    return { senderId: candidate.id.senderId, msgId: candidate.id.msgId };
}

async function writeCanonicalMessage(transaction: ALAdmissionWriteContext, candidate: ALMessage = message): Promise<void> {
    const retainUntilMs = Date.now() + 60_000;
    await transaction.set(
        `inbound:message:${encodeURIComponent(candidate.id.senderId)}:${encodeURIComponent(candidate.id.msgId)}`,
        { msgId: candidate.id.msgId, senderId: candidate.id.senderId, msg: candidate, retainUntilMs },
        retainUntilMs
    );
}

function createWork(effectId = 'effect', payload: ALInboundDurableEffect = { kind: 'release-buffered', trackKey: 'track', seq: 2 }) {
    return computeALInboundWorkEntry({
        namespace: 'inbound',
        effectId,
        payload,
        observedAtMs: Date.now(),
        expireAtTimestamp: Date.now() + 60_000
    });
}

/** The claim step of the worker: the port reserves what the page observed, corruption is released as observed. */
async function claimWork(port: ALWorkQueuePort, namespace: string) {
    const page = await port.readPage({ status: EntityStatus.NEW, maxToRead: 10, cursor: null });
    const claimed: ALPersistedInboundEffect[] = [];
    for (const claim of await port.claim({ maxCount: 10, observedEntries: page.entries })) {
        try {
            claimed.push(decodeALInboundWorkEntry(claim.entry, namespace));
        }
        catch (error) {
            if (!(error instanceof ALAdmissionCorruptionError)) {
                throw error;
            }
            await port.release(claim, { status: 'non-retryable' });
        }
    }
    return claimed;
}

interface PendingAdmissionBundleInput {
    readonly senderId: string;
    readonly observations: ALInboundAdmissionObservations;
    readonly nextIndex: ALInboundControlOwnerIndex;
    readonly expireAtTimestamp: number;
}

function createPendingAdmissionBundle(input: PendingAdmissionBundleInput): ALInboundCommitBundle {
    return {
        admissionExpiresAtMs: null,
        senderId: input.senderId,
        observations: input.observations,
        mutations: [{
            kind: 'set-msg-owner',
            value: {
                msgId: message.id.msgId,
                senderId: input.senderId,
                source: { kind: 'ws-client', peerId: input.senderId },
                supersedenceKey: null
            },
            expireAtTimestamp: input.expireAtTimestamp
        }, {
            kind: 'set-control-pending',
            msgId: message.id.msgId,
            senderId: input.senderId,
            value: {
                kind: 'pending',
                value: {
                    toPeerId: 'upstream',
                    status: 'subtree-complete',
                    localReady: true,
                    expectedFromPeerIds: ['receiver'],
                    ackedFromPeerIds: [],
                    expireAtTimestamp: input.expireAtTimestamp
                }
            },
            expireAtTimestamp: input.expireAtTimestamp
        }, {
            kind: 'set-control-owners',
            msgId: message.id.msgId,
            value: input.nextIndex,
            expireAtTimestamp: input.expireAtTimestamp
        }],
        durableEffects: []
    };
}

describe('inbound admission persisted values', () => {
    it('rejects a delimiter-containing message owner mismatch before admission planning', async () => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:msg-owner:message:sender%3Awith%3Adelimiter', {
                msgId: message.id.msgId,
                senderId: 'delimiter',
                source: { kind: 'ws-client', peerId: 'delimiter' },
                supersedenceKey: null
            });
        });

        await expect(readIncoming(store, message)).rejects.toMatchObject({
            name: 'ALAdmissionCorruptionError',
            key: 'inbound:msg-owner:message:sender%3Awith%3Adelimiter'
        });
    });

    it.each([
        { kind: 'trusted-server', groupRecipientPeerIds: ['receiver'] },
        { kind: 'rtc-peer', peerId: message.id.senderId, groupRecipientPeerIds: ['receiver'] }
    ])('rejects room recipient metadata on persisted $kind provenance', async (source) => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:msg-owner:message:sender%3Awith%3Adelimiter', {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source,
                supersedenceKey: null
            });
        });

        await expect(store.readStoredPlanningState({ msg: message, nowMs: Date.now() }))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('retains a frozen group audience larger than the wire collection limit', async () => {
        const { store } = createFixture();
        const groupRecipientPeerIds = Array.from({ length: 1_500 }, (_, index) => `room-peer-${index}`);
        const expireAtTimestamp = Date.now() + 60_000;
        expect(
            await store.commitBundle({
                admissionExpiresAtMs: null,
                senderId: message.id.senderId,
                observations: (await readIncoming(store, message)).observations,
                mutations: [{
                    kind: 'set-msg-owner',
                    value: {
                        msgId: message.id.msgId,
                        senderId: message.id.senderId,
                        source: { kind: 'ws-client', peerId: message.id.senderId, groupRecipientPeerIds },
                        supersedenceKey: null
                    },
                    expireAtTimestamp
                }],
                durableEffects: []
            })
        ).toBe('committed');

        await expect(store.readStoredPlanningState({ msg: message, nowMs: Date.now() })).resolves.toMatchObject({
            source: { kind: 'ws-client', peerId: message.id.senderId, groupRecipientPeerIds }
        });
    });

    it.each([
        { lastContiguousSeq: 1, bufferedSeqs: ['2'], updatedAtMs: 1 },
        { lastContiguousSeq: 1, bufferedSeqs: [2, 2], updatedAtMs: 1 },
        { lastContiguousSeq: 1, bufferedSeqs: [1], updatedAtMs: 1 },
        { lastContiguousSeq: 1, bufferedSeqs: [2], updatedAtMs: Number.NaN }
    ])('rejects malformed ordering snapshots instead of treating them as expired', async (value) => {
        const { state, backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:ordering:${toALOrderingTrackKey(message)}`, value);
        });

        await expect(readIncoming(store, message)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects malformed pending acknowledgement state', async () => {
        const { backend, store, control } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:control:pending:message:sender%3Awith%3Adelimiter', {
                kind: 'pending',
                value: { msgId: 'different', upstreamPeerId: 'sender', expectedPeerIds: [], ackedPeerIds: [], localDelivered: false }
            });
        });

        await expect(readIncoming(store, message)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects malformed nested plans in direct buffered reads', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await writeCanonicalMessage(transaction);
            await transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 1, expireAtTimestamp: Date.now() + 60_000 });
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, {
                ...snapshot,
                plan: { ...snapshot.plan, effective: { ...snapshot.plan.effective, ack: { algo: 'hop', opts: {} } } }
            });
        });

        await expect(store.readBufferedRelease({ trackKey: snapshot.trackKey, seq: 2, nowMs: Date.now() })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { requested: { ack: { algo: 'unknown' } } },
        { notes: [{ aspect: 'unknown', kind: 'defaulted', reason: 'default' }] },
        { unmetRequirements: [1] },
        { dedupKey: 1 },
        { dropReason: false },
        { localDelivery: { enabled: 'yes', persist: false, deferred: false } },
        { forwarding: { enabled: true, persist: false, nextHopPeerIds: [1] } },
        { ack: { enabled: true, algo: 'hop', deferred: 1 } },
        { nack: { enabled: false, missingSeqs: [-1] } },
        { repair: { enabled: true, algo: 'unknown' } },
        { supersedence: { enabled: true, algo: 'latest-wins', status: 'unknown' } },
        { congestion: { overloaded: false, action: 'none', priority: Number.NaN } },
        { ownership: { algo: 'shared', exclusive: 1 } },
        { orderingRuntime: { status: 'gap', missingSeqs: [1], releasableSeqs: ['2'] } }
    ])('rejects malformed persisted handling-plan sections before buffered release', async (corruption) => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await writeCanonicalMessage(transaction);
            await transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 1, expireAtTimestamp: Date.now() + 60_000 });
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, {
                ...snapshot,
                plan: { ...snapshot.plan, ...corruption }
            });
        });

        await expect(store.readBufferedRelease({ trackKey: snapshot.trackKey, seq: 2, nowMs: Date.now() })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a buffered snapshot whose sequence disagrees with its storage slot on direct and list reads', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:3`, snapshot);
        });

        await expect(store.readBufferedRelease({ trackKey: snapshot.trackKey, seq: 3, nowMs: Date.now() })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(readIncoming(store, message)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a buffered snapshot whose canonical message belongs to another ordering track', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        const other: ALMessage = {
            ...message,
            id: { ...message.id, msgId: 'other-track-message' },
            ordering: { orderingKey: 'other-track', seq: 2 }
        };
        await backend.write(async (transaction) => {
            await writeCanonicalMessage(transaction, other);
            await transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 1, expireAtTimestamp: Date.now() + 60_000 });
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, {
                ...snapshot,
                message: toMessageReference(other)
            });
        });

        await expect(store.readOrderedDelivery(snapshot.trackKey, 4)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.readBufferedRelease({ trackKey: snapshot.trackKey, seq: 2, nowMs: Date.now() }))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a buffered snapshot whose canonical message row is gone on every ordering read', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 1, expireAtTimestamp: Date.now() + 60_000 });
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, { ...snapshot, delivery: { effectId: 'owner' } });
        });

        await expect(store.readOrderedDelivery(snapshot.trackKey, 4)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a buffered snapshot whose canonical message row is gone', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, snapshot);
        });

        await expect(store.readBufferedRelease({ trackKey: snapshot.trackKey, seq: 2, nowMs: Date.now() }))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('marks malformed work NON_RETRYABLE while reserving valid siblings', async () => {
        const { store, workQueue, port } = createFixture();
        const valid = createWork('valid').entry;
        const malformed = { ...createWork('malformed').entry, resource: '{invalid-json' };
        await workQueue.enqueue(valid);
        await workQueue.enqueue(malformed);

        expect((await claimWork(port, store.namespace)).map((effect) => effect.effectId)).toEqual(['valid']);
        expect(await workQueue.getItem(valid.key)).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
        expect(await workQueue.getItem(malformed.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
    });

    it.each([
        { effectId: 'owner', inboxKey: { topicId: 'chat', resourceId: 'wrong', contextId: 'room' } },
        { effectId: 'owner', inboxKey: { topicId: 'chat', resourceId: 'resource', contextId: 1 } },
        { effectId: 1 }
    ])('rejects malformed buffered delivery ownership before resolving predecessors', async (delivery) => {
        const { backend, store, control } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await writeCanonicalMessage(transaction);
            await transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 1, expireAtTimestamp: Date.now() + 60_000 });
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, { ...snapshot, delivery });
        });

        await expect(store.readOrderedDelivery(snapshot.trackKey, 4)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { kind: 'forward-message', message: { senderId: 'sender:with:delimiter', msgId: 'message' }, fromPeerId: 'sender', plan: {} },
        { kind: 'send-control', msg: message },
        { kind: 'unknown' },
        { kind: 'send-control', msg: { ...message, payload: { typeId: 'al.control.ack.v1', resource: '{}' } } }
    ])('terminalizes corrupt work payloads at observed reservation', async (payload) => {
        const { store, workQueue, port } = createFixture();
        const entry = {
            ...createWork().entry,
            resource: JSON.stringify({ namespace: 'inbound', effectId: 'effect', payload })
        };
        await workQueue.enqueue(entry);
        expect(await claimWork(port, store.namespace)).toEqual([]);
        expect(await workQueue.getItem(entry.key)).toMatchObject({ status: EntityStatus.NON_RETRYABLE });
    });

    it.each(
        [
            { name: 'track', payload: { kind: 'release-buffered', trackKey: 'another-track', seq: 2 } },
            { name: 'sequence', payload: { kind: 'release-buffered', trackKey: toALOrderingTrackKey(message)!, seq: 50 } },
            {
                name: 'message',
                payload: {
                    kind: 'dispatch-local',
                    message: { senderId: message.id.senderId, msgId: 'another-message' }
                }
            },
            {
                name: 'non-delivery',
                payload: {
                    kind: 'forward-message',
                    message: toMessageReference(message),
                    plan: planMessage(message),
                    fromPeerId: 'sender'
                }
            }
        ] satisfies readonly { name: string; payload: ALInboundDurableEffect; }[]
    )(
        'rejects a structurally valid effect with a mismatched $name delivery owner',
        async ({ payload }) => {
            const { backend, store, workQueue } = createFixture();
            const snapshot = createBufferedSnapshot();
            await backend.write(async (transaction) => {
                await writeCanonicalMessage(transaction);
                await transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 1, expireAtTimestamp: Date.now() + 60_000 });
                await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, { ...snapshot, delivery: { effectId: 'owner' } });
            });

            await workQueue.enqueue(createWork('owner', payload).entry);
            await expect(store.readOrderedDelivery(snapshot.trackKey, 3)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        }
    );

    it('requires durable delivery progress before a cleaned-up work owner can be skipped', async () => {
        const { backend, store, workQueue, port, control } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await writeCanonicalMessage(transaction);
            await transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 1, expireAtTimestamp: Date.now() + 60_000 });
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, { ...snapshot, delivery: { effectId: 'owner' } });
        });
        const work = createWork('owner', { kind: 'release-buffered', trackKey: snapshot.trackKey, seq: 2 });
        await workQueue.enqueue(work.entry);
        expect(await store.readOrderedDelivery(snapshot.trackKey, 3)).toEqual({ completedThrough: 1, predecessor: { kind: 'effect' } });
        const [reservation] = await claimWork(port, store.namespace);
        await workQueue.releaseEntries([reservation!.entry], { status: EntityStatus.COMPLETED, delayMs: null });
        await workQueue.removeItem(work.entry.key);
        expect(await store.readOrderedDelivery(snapshot.trackKey, 3)).toEqual({ completedThrough: 1, predecessor: { kind: 'resync-required' } });
        await backend.write((transaction) =>
            transaction.set(`inbound:delivered:${snapshot.trackKey}`, { completedThrough: 2, expireAtTimestamp: Date.now() + 60_000 })
        );
        expect(await store.readOrderedDelivery(snapshot.trackKey, 3)).toEqual({ completedThrough: 2, predecessor: undefined });
    });

    it('rejects control history whose message ID differs from the trusted requested slot', async () => {
        const { backend, store, control } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:control:acks:message:sender%3Awith%3Adelimiter', {
                kind: 'acks',
                values: [{ ackedMsgId: 'different', fromPeerId: 'sender', toPeerId: 'receiver', status: 'delivered', observedAtEpochMs: 1 }]
            });
        });

        await expect(readIncoming(store, message)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { senderId: 'sender:with:delimiter' },
        { senderId: 1, msgId: 'message' },
        { senderId: 'sender:with:delimiter', msgId: 1 },
        { senderId: 'sender:with:delimiter', msgId: 'message', route: 'chat' }
    ])('marks malformed embedded message references as NON_RETRYABLE', async (reference) => {
        const { store, workQueue, port } = createFixture();
        const entry = {
            ...createWork().entry,
            resource: JSON.stringify({
                namespace: 'inbound',
                effectId: 'effect',
                payload: { kind: 'dispatch-local', message: reference }
            })
        };
        await workQueue.enqueue(entry);
        expect(await claimWork(port, store.namespace)).toEqual([]);
        expect(await workQueue.getItem(entry.key)).toMatchObject({ status: EntityStatus.NON_RETRYABLE });
    });

    it.each([
        { namespace: 'wrong-scope', effectId: 'effect' },
        { namespace: 'inbound', effectId: 'prefix:effect' }
    ])('rejects queued work whose stored identity differs from its slot', async (identity) => {
        const { store, workQueue, port } = createFixture();
        const work = createWork();
        const entry = { ...work.entry, resource: JSON.stringify({ ...identity, payload: work.payload }) };
        expect(() => decodeALInboundWorkEntry(entry, 'inbound')).toThrow(ALAdmissionCorruptionError);
        await workQueue.enqueue(entry);
        expect(await claimWork(port, store.namespace)).toEqual([]);
        expect(await workQueue.getItem(entry.key)).toMatchObject({ status: EntityStatus.NON_RETRYABLE });
    });

    it('rolls back earlier admission writes when the existing durable effect is corrupt', async () => {
        const { state, store, workQueue } = createFixture();
        const work = createWork();
        await workQueue.enqueue({ ...work.entry, resource: '{invalid-json' });

        await expect(store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readIncoming(store, message)).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: message.id.senderId },
                    supersedenceKey: null
                },
                expireAtTimestamp: Date.now() + 60_000
            }],
            durableEffects: [createWork()]
        })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect([...state.data.keys()]).toEqual([]);
        expect((await workQueue.getItem(work.entry.key))?.resource).toBe('{invalid-json');
    });

    it('rejects a durable effect identity reused for different payload ownership', async () => {
        const { store } = createFixture();
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readIncoming(store, message)).observations,
            mutations: [],
            durableEffects: [createWork()]
        });

        await expect(store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readIncoming(store, message)).observations,
            mutations: [],
            durableEffects: [createWork('effect', { kind: 'release-buffered', trackKey: 'other-track', seq: 2 })]
        })).rejects.toMatchObject({
            name: 'ALAdmissionCorruptionError',
            key: JSON.stringify(toALInboundWorkKey('inbound', 'effect'))
        });
    });

    it('retains independent provenance for the same message id from distinct senders', async () => {
        const { state, store } = createFixture();
        const secondMessage = {
            ...message,
            id: { ...message.id, senderId: 'second-sender' }
        };
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readIncoming(store, message)).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: message.id.senderId },
                    supersedenceKey: null
                },
                expireAtTimestamp: Date.now() + 60_000
            }],
            durableEffects: []
        });
        expect(
            await store.commitBundle({
                admissionExpiresAtMs: null,
                senderId: secondMessage.id.senderId,
                observations: (await readIncoming(store, secondMessage)).observations,
                mutations: [{
                    kind: 'set-msg-owner',
                    value: {
                        msgId: secondMessage.id.msgId,
                        senderId: secondMessage.id.senderId,
                        source: { kind: 'ws-client', peerId: secondMessage.id.senderId },
                        supersedenceKey: null
                    },
                    expireAtTimestamp: Date.now() + 60_000
                }],
                durableEffects: []
            })
        ).toBe('committed');

        expect((await store.readStoredPlanningState({ msg: message, nowMs: Date.now() })).source)
            .toEqual({ kind: 'ws-client', peerId: message.id.senderId });
        expect((await store.readStoredPlanningState({ msg: secondMessage, nowMs: Date.now() })).source)
            .toEqual({ kind: 'ws-client', peerId: secondMessage.id.senderId });
        expect([...state.data.keys()].filter((key) => key.startsWith('inbound:msg-owner:')).sort()).toEqual([
            'inbound:msg-owner:message:second-sender',
            'inbound:msg-owner:message:sender%3Awith%3Adelimiter'
        ]);
    });

    it('rejects an ambiguous acknowledgement without narrowing same-ID message admission', async () => {
        const { state, store, control } = createFixture();
        const expireAtTimestamp = Date.now() + 60_000;
        const firstIndex = {
            ambiguous: false,
            values: [{ peerId: 'receiver', senderId: message.id.senderId }]
        } as const;
        expect(
            await store.commitBundle(createPendingAdmissionBundle({
                senderId: message.id.senderId,
                observations: (await readIncoming(store, message)).observations,
                nextIndex: firstIndex,
                expireAtTimestamp
            }))
        ).toBe('committed');
        expect(
            await store.commitBundle(createPendingAdmissionBundle({
                senderId: 'second-sender',
                observations: (await readIncoming(store, { ...message, id: { ...message.id, senderId: 'second-sender' } })).observations,
                nextIndex: { ambiguous: false, values: [{ peerId: 'receiver', senderId: null }] },
                expireAtTimestamp
            }))
        ).toBe('committed');

        expect(await control.admit(createAcknowledgement('receiver'))).toEqual({ kind: 'not-handled' });
        expect([...state.data.keys()].filter((key) => key.startsWith('inbound:control:pending:')).sort())
            .toEqual([
                'inbound:control:pending:message:second-sender',
                'inbound:control:pending:message:sender%3Awith%3Adelimiter'
            ]);
    });

    it('retains admit-control work when pending receipt progress changes after an ACK read', async () => {
        const { state, backend, store, port, control } = createFixture();
        await seedPendingAcknowledgement(store, ['receiver']);
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation) => {
            await write(async (transaction) => {
                await transaction.set(
                    'inbound:control:pending:message:sender%3Awith%3Adelimiter',
                    {
                        kind: 'pending',
                        value: {
                            toPeerId: 'upstream',
                            status: 'subtree-complete',
                            localReady: false,
                            expectedFromPeerIds: ['receiver'],
                            ackedFromPeerIds: [],
                            expireAtTimestamp: Date.now() + 60_000
                        }
                    },
                    Date.now() + 60_000
                );
            });
            return await write(operation);
        });

        expect(await control.admit(createAcknowledgement('receiver'))).toEqual({ kind: 'pending-control' });
        expect(state.data.has('inbound:control:acks:message:sender%3Awith%3Adelimiter')).toBe(false);
        expect((await claimWork(port, store.namespace)).map((effect) => effect.payload.kind)).toEqual(['admit-control']);
    });

    it('retains admit-control work when another sender makes ACK ownership ambiguous after the read', async () => {
        const { state, backend, store, port, control } = createFixture();
        await seedPendingAcknowledgement(store, ['receiver']);
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation) => {
            await write((transaction) =>
                transaction.set(
                    'inbound:control:owners:message',
                    { ambiguous: false, values: [{ peerId: 'receiver', senderId: null }] },
                    Date.now() + 60_000
                )
            );
            return await write(operation);
        });

        expect(await control.admit(createAcknowledgement('receiver'))).toEqual({ kind: 'pending-control' });
        expect(state.data.has('inbound:control:acks:message:sender%3Awith%3Adelimiter')).toBe(false);
        expect(state.data.get('inbound:control:pending:message:sender%3Awith%3Adelimiter')).toBeDefined();
        expect((await claimWork(port, store.namespace)).map((effect) => effect.payload.kind)).toEqual(['admit-control']);
    });

    it('treats retained ACK state without provenance as typed corruption', async () => {
        const { backend, control } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:control:owners:message', {
                ambiguous: false,
                values: [{ peerId: 'receiver', senderId: message.id.senderId }]
            });
            await transaction.set('inbound:control:pending:message:sender%3Awith%3Adelimiter', {
                kind: 'pending',
                value: {
                    toPeerId: 'upstream',
                    status: 'subtree-complete',
                    localReady: false,
                    expectedFromPeerIds: ['receiver'],
                    ackedFromPeerIds: []
                }
            });
        });

        await expect(control.admit(createAcknowledgement('receiver')))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('caps ACK diagnostics while completing the independent frozen audience snapshot', async () => {
        const { state, backend, store, control } = createFixture();
        const expectedPeerIds = Array.from({ length: 256 }, (_, index) => `receiver-${index}`);
        await seedPendingAcknowledgement(store, expectedPeerIds, expectedPeerIds.slice(0, -1));
        const values = [
            ...expectedPeerIds.slice(0, -1).map((fromPeerId, observedAtEpochMs) => ({
                ackedMsgId: message.id.msgId,
                fromPeerId,
                toPeerId: 'self',
                status: 'accepted' as const,
                observedAtEpochMs
            })),
            {
                ackedMsgId: message.id.msgId,
                fromPeerId: expectedPeerIds[0]!,
                toPeerId: 'self',
                status: 'delivered' as const,
                observedAtEpochMs: 256
            }
        ];
        await backend.write((transaction) =>
            transaction.set(
                'inbound:control:acks:message:sender%3Awith%3Adelimiter',
                { kind: 'acks', values },
                Date.now() + 60_000
            )
        );

        expect(await control.admit(createAcknowledgement('receiver-255'))).toMatchObject({
            kind: 'committed',
            acceptance: { handled: true }
        });
        expect(state.data.has('inbound:control:pending:message:sender%3Awith%3Adelimiter')).toBe(false);
        expect((await readIncoming(store, message)).acks).toHaveLength(256);
    });

    it('round-trips the local-delivery reference and retains the message once', async () => {
        const { state, store, port, control } = createFixture();
        const retainUntilMs = Date.now() + 120_000;
        const work = createWork('dispatch', { kind: 'dispatch-local', message: toMessageReference(message) });
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readIncoming(store, message)).observations,
            mutations: [{
                kind: 'set-inbound-message',
                value: { msgId: message.id.msgId, senderId: message.id.senderId, msg: message, retainUntilMs },
                expireAtTimestamp: retainUntilMs
            }],
            durableEffects: [work]
        });
        const [claimed] = await claimWork(port, store.namespace);
        expect(claimed?.payload).toEqual({ kind: 'dispatch-local', message: toMessageReference(message) });
        expect(await store.readInboundMessage(toMessageReference(message))).toEqual(message);
        expect([...state.data.keys()].filter((key) => key.startsWith('inbound:message:'))).toEqual([
            'inbound:message:sender%3Awith%3Adelimiter:message'
        ]);
    });
});

async function seedPendingAcknowledgement(
    store: ReturnType<typeof createFixture>['store'],
    expectedFromPeerIds: readonly string[],
    ackedFromPeerIds: readonly string[] = []
): Promise<void> {
    const expireAtTimestamp = Date.now() + 60_000;
    expect(
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readIncoming(store, message)).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: message.id.senderId },
                    supersedenceKey: null
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-pending',
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                value: {
                    kind: 'pending',
                    value: {
                        toPeerId: 'upstream',
                        status: 'subtree-complete',
                        localReady: true,
                        expectedFromPeerIds,
                        ackedFromPeerIds,
                        expireAtTimestamp
                    }
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-owners',
                msgId: message.id.msgId,
                value: {
                    ambiguous: false,
                    values: expectedFromPeerIds.map((peerId) => ({ peerId, senderId: message.id.senderId }))
                },
                expireAtTimestamp
            }],
            durableEffects: []
        })
    ).toBe('committed');
}

function createAcknowledgement(fromPeerId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${fromPeerId}`, ts: 1, senderId: fromPeerId },
        {
            ackedMsgId: message.id.msgId,
            fromPeerId,
            toPeerId: 'self',
            status: 'accepted',
            observedAtEpochMs: 1
        }
    );
}

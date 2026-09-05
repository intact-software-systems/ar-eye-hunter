import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundCommitBundle,
    type ALInboundControlOwnerIndex
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { describe, expect, it, vi } from 'vitest';

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
    return { state, backend, store };
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
    return { trackKey: toALOrderingTrackKey(message)!, seq: 2, msg: message, plan: planMessage(message) };
}

function createStoredEffect(effectId = 'effect') {
    return {
        effectId,
        payload: { kind: 'release-buffered', trackKey: 'track', seq: 2 },
        status: 'pending',
        attempts: 0,
        retryAtMs: 0,
        updatedAtMs: Date.now(),
        expireAtTimestamp: Date.now() + 60_000
    };
}

interface PendingAdmissionBundleInput {
    readonly senderId: string;
    readonly expectedIndex: ALInboundControlOwnerIndex | undefined;
    readonly nextIndex: ALInboundControlOwnerIndex;
    readonly expireAtTimestamp: number;
}

function createPendingAdmissionBundle(input: PendingAdmissionBundleInput): ALInboundCommitBundle {
    return {
        senderId: input.senderId,
        versionExpireAtTimestamp: input.expireAtTimestamp,
        mutations: [{
            kind: 'set-msg-owner',
            msgId: message.id.msgId,
            senderId: input.senderId,
            source: { kind: 'ws-client', peerId: input.senderId },
            supersedenceKey: null,
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
            expected: input.expectedIndex,
            value: input.nextIndex,
            expireAtTimestamp: input.expireAtTimestamp
        }],
        durableEffects: []
    };
}

describe('inbound admission persisted values', () => {
    it('rejects a delimiter-containing client identity mismatch before admission planning', async () => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:version:sender:with:delimiter', { senderId: 'delimiter', version: 1 });
        });

        await expect(readIncoming(store, message)).rejects.toMatchObject({
            name: 'ALAdmissionCorruptionError',
            key: 'inbound:version:sender:with:delimiter'
        });
    });

    it.each([
        { kind: 'trusted-server', roomRecipientPeerIds: ['receiver'] },
        { kind: 'rtc-peer', peerId: message.id.senderId, roomRecipientPeerIds: ['receiver'] }
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

    it('retains a frozen room audience larger than the wire collection limit', async () => {
        const { store } = createFixture();
        const roomRecipientPeerIds = Array.from({ length: 1_500 }, (_, index) => `room-peer-${index}`);
        const expireAtTimestamp = Date.now() + 60_000;
        expect(
            await store.commitBundle({
                senderId: message.id.senderId,
                versionExpireAtTimestamp: expireAtTimestamp,
                mutations: [{
                    kind: 'set-msg-owner',
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: message.id.senderId, roomRecipientPeerIds },
                    supersedenceKey: null,
                    expireAtTimestamp
                }],
                durableEffects: []
            })
        ).toBe('committed');

        await expect(store.readStoredPlanningState({ msg: message, nowMs: Date.now() })).resolves.toMatchObject({
            source: { kind: 'ws-client', peerId: message.id.senderId, roomRecipientPeerIds }
        });
    });

    it.each([
        { lastContiguousSeq: 1, bufferedSeqs: ['2'], updatedAtMs: 1 },
        { lastContiguousSeq: 1, bufferedSeqs: [2, 2], updatedAtMs: 1 },
        { lastContiguousSeq: 1, bufferedSeqs: [1], updatedAtMs: 1 },
        { lastContiguousSeq: 1, bufferedSeqs: [2], updatedAtMs: Number.NaN }
    ])('rejects malformed ordering snapshots instead of treating them as expired', async (value) => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:ordering:${toALOrderingTrackKey(message)}`, value);
        });

        await expect(readIncoming(store, message)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects malformed pending acknowledgement state', async () => {
        const { backend, store } = createFixture();
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

    it('rejects a buffered snapshot whose message belongs to another ordering track', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, {
                ...snapshot,
                msg: { ...message, id: { ...message.id, senderId: 'wrong-sender' } }
            });
        });

        await expect(store.readDeliveryPredecessors(snapshot.trackKey, 4)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('fails a whole effect claim on malformed rows without leasing valid siblings', async () => {
        const { state, backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:effect:valid', createStoredEffect('valid'));
            await transaction.set('inbound:effect:malformed', { ...createStoredEffect('malformed'), payload: { kind: 'release-buffered' } });
        });

        await expect(store.claimReadyEffects({ workerId: 'worker', maxCount: 10, leaseMs: 100, nowMs: Date.now() }))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect(state.data.get('inbound:effect:valid')?.value).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it.each([
        { effectId: 'owner', inboxKey: { topicId: 'chat', resourceId: 'wrong', contextId: 'room' } },
        { effectId: 'owner', inboxKey: { topicId: 'chat', resourceId: 'resource', contextId: 1 } },
        { effectId: 1 }
    ])('rejects malformed buffered delivery ownership before resolving predecessors', async (delivery) => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, { ...snapshot, delivery });
        });

        await expect(store.readDeliveryPredecessors(snapshot.trackKey, 4)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { status: 'unknown' },
        { status: 'running', leaseOwner: 'worker' },
        { status: 'pending', leaseOwner: 'worker', leaseUntilMs: 10 },
        { attempts: 0.5 },
        { retryAtMs: Number.NaN },
        { lastError: { message: 'not a string' } },
        { payload: { kind: 'forward-message', msg: message, fromPeerId: 'sender', plan: {} } },
        { payload: { kind: 'send-control', msg: message } },
        { payload: { kind: 'unknown' } },
        { payload: { kind: 'send-control', msg: { ...message, payload: { typeId: 'al.control.ack.v1', resource: '{}' } } } }
    ])('rejects corrupt effect headers or payloads in direct lifecycle operations', async (corruption) => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:effect:effect', { ...createStoredEffect(), ...corruption });
        });

        await expect(store.completeEffect('effect', 'worker')).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { name: 'track', payload: { kind: 'release-buffered', trackKey: 'another-track', seq: 2 } },
        { name: 'sequence', payload: { kind: 'release-buffered', trackKey: toALOrderingTrackKey(message), seq: 50 } },
        {
            name: 'message',
            payload: {
                kind: 'dispatch-local',
                entry: QueueBoxUtilities.toResourceEntryFromMsg({ ...message, id: { ...message.id, msgId: 'another-message' } }, 'inbox')
            }
        },
        { name: 'non-delivery', payload: { kind: 'forward-message', msg: message, plan: planMessage(message), fromPeerId: 'sender' } },
        {
            name: 'missing-inbox',
            payload: { kind: 'enqueue-inbox', entry: QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox') }
        }
    ])(
        'rejects a structurally valid effect with a mismatched $name delivery owner',
        async ({ payload }) => {
            const { backend, store } = createFixture();
            const snapshot = createBufferedSnapshot();
            await backend.write(async (transaction) => {
                await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, { ...snapshot, delivery: { effectId: 'owner' } });
                await transaction.set('inbound:effect:owner', { ...createStoredEffect('owner'), payload });
            });

            await expect(store.readDeliveryPredecessors(snapshot.trackKey, 3)).rejects.toMatchObject({
                name: 'ALAdmissionCorruptionError',
                key: 'inbound:effect:owner'
            });
        }
    );

    it('keeps an exact release owner fenced and allows a completed owner to disappear', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:2`, { ...snapshot, delivery: { effectId: 'arbitrary-owner' } });
            await transaction.set('inbound:effect:arbitrary-owner', {
                ...createStoredEffect('arbitrary-owner'),
                payload: { kind: 'release-buffered', trackKey: snapshot.trackKey, seq: snapshot.seq }
            });
        });

        await expect(store.readDeliveryPredecessors(snapshot.trackKey, 3)).resolves.toEqual([{ kind: 'effect' }]);
        await backend.write((transaction) => transaction.remove('inbound:effect:arbitrary-owner'));
        await expect(store.readDeliveryPredecessors(snapshot.trackKey, 3)).resolves.toEqual([]);
    });

    it('rejects control history whose message ID differs from the trusted requested slot', async () => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:control:acks:message:sender%3Awith%3Adelimiter', {
                kind: 'acks',
                values: [{ ackedMsgId: 'different', fromPeerId: 'sender', toPeerId: 'receiver', status: 'delivered', observedAtEpochMs: 1 }]
            });
        });

        await expect(readIncoming(store, message)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { key: { topicId: 'chat', resourceId: 'other', contextId: 'room' } },
        { status: 'unknown' },
        { dequeueAudit: { attempts: 'one' } },
        { audit: { date: '12:00:00', createdBy: 'sender', createdTs: '2026-08-31T12:00:00', expiryTs: 'not-a-time' } },
        { resource: '{}' }
    ])('rejects malformed or wrong-route durable queue entries', async (corruption) => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:effect:effect', {
                ...createStoredEffect(),
                payload: {
                    kind: 'dispatch-local',
                    entry: { ...QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox'), ...corruption }
                }
            });
        });

        await expect(store.claimReadyEffects({ workerId: 'worker', maxCount: 1, leaseMs: 100, nowMs: Date.now() }))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a listed effect whose identity does not equal the complete suffix', async () => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:effect:prefix:effect', createStoredEffect('effect'));
        });

        await expect(store.peekNextEffectReadyAt()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.completeEffect('prefix:effect', 'worker')).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rolls back earlier admission writes when the existing durable effect is corrupt', async () => {
        const { state, backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:effect:effect', { ...createStoredEffect(), attempts: -1 });
        });

        await expect(store.commitBundle({
            senderId: message.id.senderId,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'ws-client', peerId: message.id.senderId },
                supersedenceKey: null,
                expireAtTimestamp: Date.now() + 60_000
            }],
            durableEffects: [{
                effectId: 'effect',
                expireAtTimestamp: Date.now() + 60_000,
                payload: { kind: 'release-buffered', trackKey: 'track', seq: 2 }
            }]
        })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect([...state.data.keys()]).toEqual(['inbound:effect:effect']);
    });

    it('rejects a durable effect identity reused for different payload ownership', async () => {
        const { store } = createFixture();
        await store.commitBundle({
            senderId: message.id.senderId,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [],
            durableEffects: [{
                effectId: 'effect',
                expireAtTimestamp: Date.now() + 60_000,
                payload: { kind: 'release-buffered', trackKey: 'track', seq: 2 }
            }]
        });

        await expect(store.commitBundle({
            senderId: message.id.senderId,
            expectedVersion: 1,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [],
            durableEffects: [{
                effectId: 'effect',
                expireAtTimestamp: Date.now() + 60_000,
                payload: { kind: 'release-buffered', trackKey: 'other-track', seq: 2 }
            }]
        })).rejects.toMatchObject({
            name: 'ALAdmissionCorruptionError',
            key: 'inbound:effect:effect'
        });
    });

    it('retains independent provenance for the same message id from distinct senders', async () => {
        const { state, store } = createFixture();
        const secondMessage = {
            ...message,
            id: { ...message.id, senderId: 'second-sender' }
        };
        await store.commitBundle({
            senderId: message.id.senderId,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'ws-client', peerId: message.id.senderId },
                supersedenceKey: null,
                expireAtTimestamp: Date.now() + 60_000
            }],
            durableEffects: []
        });
        expect(
            await store.commitBundle({
                senderId: secondMessage.id.senderId,
                versionExpireAtTimestamp: Date.now() + 60_000,
                mutations: [{
                    kind: 'set-msg-owner',
                    msgId: secondMessage.id.msgId,
                    senderId: secondMessage.id.senderId,
                    source: { kind: 'ws-client', peerId: secondMessage.id.senderId },
                    supersedenceKey: null,
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
        const { state, store } = createFixture();
        const expireAtTimestamp = Date.now() + 60_000;
        const firstIndex = {
            ambiguous: false,
            values: [{ peerId: 'receiver', senderId: message.id.senderId }]
        } as const;
        expect(
            await store.commitBundle(createPendingAdmissionBundle({
                senderId: message.id.senderId,
                expectedIndex: undefined,
                nextIndex: firstIndex,
                expireAtTimestamp
            }))
        ).toBe('committed');
        expect(
            await store.commitBundle(createPendingAdmissionBundle({
                senderId: 'second-sender',
                expectedIndex: firstIndex,
                nextIndex: { ambiguous: false, values: [{ peerId: 'receiver', senderId: null }] },
                expireAtTimestamp
            }))
        ).toBe('committed');

        expect(await store.acceptControlMessage(createAcknowledgement('receiver'))).toEqual({
            handled: false,
            completedPendingAcks: []
        });
        expect([...state.data.keys()].filter((key) => key.startsWith('inbound:control:pending:')).sort())
            .toEqual([
                'inbound:control:pending:message:second-sender',
                'inbound:control:pending:message:sender%3Awith%3Adelimiter'
            ]);
    });

    it('reports a typed conflict when the sender version changes after an ACK read', async () => {
        const { backend, state, store } = createFixture();
        await seedPendingAcknowledgement(store, ['receiver']);
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation) => {
            await write(async (transaction) => {
                await transaction.set(
                    `inbound:version:${message.id.senderId}`,
                    { senderId: message.id.senderId, version: 2 },
                    Date.now() + 60_000
                );
            });
            return await write(operation);
        });

        await expect(store.acceptControlMessage(createAcknowledgement('receiver')))
            .rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(state.data.has('inbound:control:acks:message:sender%3Awith%3Adelimiter')).toBe(false);
    });

    it('reports a typed conflict when another sender makes ACK ownership ambiguous after the read', async () => {
        const { backend, state, store } = createFixture();
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

        await expect(store.acceptControlMessage(createAcknowledgement('receiver')))
            .rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(state.data.has('inbound:control:acks:message:sender%3Awith%3Adelimiter')).toBe(false);
        expect(state.data.get('inbound:control:pending:message:sender%3Awith%3Adelimiter')).toBeDefined();
    });

    it('treats retained ACK state without provenance as typed corruption', async () => {
        const { backend, store } = createFixture();
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

        await expect(store.acceptControlMessage(createAcknowledgement('receiver')))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('caps ACK diagnostics while completing the independent frozen audience snapshot', async () => {
        const { backend, state, store } = createFixture();
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

        expect(await store.acceptControlMessage(createAcknowledgement('receiver-255'))).toMatchObject({
            handled: true
        });
        expect(state.data.has('inbound:control:pending:message:sender%3Awith%3Adelimiter')).toBe(false);
        const history = state.data.get('inbound:control:acks:message:sender%3Awith%3Adelimiter')?.value as {
            readonly values: readonly unknown[];
        };
        expect(history.values).toHaveLength(256);
    });

    it('round-trips one canonical local-delivery envelope and rejects a malformed embedded message', async () => {
        const { state, backend, store } = createFixture();
        await store.commitBundle({
            senderId: message.id.senderId,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [],
            durableEffects: [{
                effectId: 'dispatch',
                expireAtTimestamp: Date.now() + 60_000,
                payload: { kind: 'dispatch-local', entry: QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox') }
            }]
        });
        const [claimed] = await store.claimReadyEffects({ workerId: 'worker', maxCount: 1, leaseMs: 100, nowMs: Date.now() });
        expect(claimed?.payload).toMatchObject({
            kind: 'dispatch-local',
            entry: { resource: JSON.stringify(message) }
        });
        expect(claimed?.payload).not.toHaveProperty('msg');
        expect(claimed?.payload).not.toHaveProperty('plan');
        const stored = state.data.get('inbound:effect:dispatch')?.value;
        expect(stored).toBeDefined();
        const serialized = JSON.stringify(stored);
        const corrupt: unknown = JSON.parse(serialized.replace('\\"v\\":2', '\\"v\\":3'));
        await backend.write(async (transaction) => {
            await transaction.set('inbound:effect:dispatch', corrupt);
        });

        await expect(store.rescheduleEffect({ effectId: 'dispatch', workerId: 'worker', retryAtMs: Date.now(), lastError: undefined }))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
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
            senderId: message.id.senderId,
            versionExpireAtTimestamp: expireAtTimestamp,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'ws-client', peerId: message.id.senderId },
                supersedenceKey: null,
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
                expected: undefined,
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

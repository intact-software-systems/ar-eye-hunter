import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { describe, expect, it } from 'vitest';

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

describe('inbound admission persisted values', () => {
    it('rejects a delimiter-containing client identity mismatch before admission planning', async () => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:version:sender:with:delimiter', { senderId: 'delimiter', version: 1 });
        });

        await expect(store.readIncomingMessage(message, 'sender', planMessage)).rejects.toMatchObject({
            name: 'ALAdmissionCorruptionError',
            key: 'inbound:version:sender:with:delimiter'
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

        await expect(store.readIncomingMessage(message, 'sender', planMessage)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects malformed pending acknowledgement state', async () => {
        const { backend, store } = createFixture();
        await backend.write(async (transaction) => {
            await transaction.set('inbound:control:pending:message', {
                kind: 'pending',
                value: { msgId: 'different', upstreamPeerId: 'sender', expectedPeerIds: [], ackedPeerIds: [], localDelivered: false }
            });
        });

        await expect(store.readIncomingMessage(message, 'sender', planMessage)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
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

        await expect(store.readBufferedRelease(snapshot.trackKey, 2)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
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

        await expect(store.readBufferedRelease(snapshot.trackKey, 2)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a buffered snapshot whose sequence disagrees with its storage slot on direct and list reads', async () => {
        const { backend, store } = createFixture();
        const snapshot = createBufferedSnapshot();
        await backend.write(async (transaction) => {
            await transaction.set(`inbound:buffered:${snapshot.trackKey}:3`, snapshot);
        });

        await expect(store.readBufferedRelease(snapshot.trackKey, 3)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.readIncomingMessage(message, 'sender', planMessage)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
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
            await transaction.set('inbound:control:acks:message', {
                kind: 'acks',
                values: [{ ackedMsgId: 'different', fromPeerId: 'sender', toPeerId: 'receiver', status: 'delivered', observedAtEpochMs: 1 }]
            });
        });

        await expect(store.readIncomingMessage(message, 'sender', planMessage)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
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
            mutations: [{ kind: 'set-msg-owner', msgId: message.id.msgId, senderId: message.id.senderId }],
            durableEffects: [{ effectId: 'effect', payload: { kind: 'release-buffered', trackKey: 'track', seq: 2 } }]
        })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect([...state.data.keys()]).toEqual(['inbound:effect:effect']);
    });

    it('round-trips one canonical local-delivery envelope and rejects a malformed embedded message', async () => {
        const { state, backend, store } = createFixture();
        await store.commitBundle({
            senderId: message.id.senderId,
            mutations: [],
            durableEffects: [{
                effectId: 'dispatch',
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

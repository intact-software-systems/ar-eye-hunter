import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';

describe('outbound admission persisted-record validation', () => {
    it('rejects wrong-slot and malformed sent snapshots in point and list reads', async () => {
        const { backend, store } = createAdmission();
        const msg = createMessage();
        await backend.write(async (tx) => {
            await tx.set('outbound:sent:wrong-slot', { msgId: msg.id.msgId, msg });
        });

        await expect(store.getSentMessage('wrong-slot')).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.getAllSentMessages()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        await backend.write(async (tx) => {
            await tx.remove('outbound:sent:wrong-slot');
            await tx.set(`outbound:sent:${msg.id.msgId}`, { msgId: msg.id.msgId, msg: { ...msg, payload: {} } });
        });
        await expect(store.getSentMessage(msg.id.msgId)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects malformed ack state and mismatched control history before mutation', async () => {
        const { backend, store } = createAdmission();
        await backend.write(async (tx) => {
            await tx.set('outbound:pending-ack:msg', {
                msgId: 'msg',
                expectedPeerIds: ['peer'],
                ackedPeerIds: [],
                timeoutMs: 50,
                maxAttempts: 3,
                attempts: 'zero',
                deadlineAtMs: Date.now() + 100
            });
        });
        await expect(store.getPendingAck('msg')).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        const msg = createMessage();
        await backend.write(async (tx) => {
            await tx.set(`outbound:control:acks:${msg.id.msgId}`, { kind: 'nacks', values: [] });
        });
        await expect(store.readOutgoingMessage(msg, () => ({ persist: false, preparedMessages: [] })))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('decodes a saved prepared message without planning or dropping its persisted content', async () => {
        const { backend, store } = createAdmission();
        const msg = createMessage();
        const effect = createEffect(msg);
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effect.effectId}`, effect);
        });
        const [claimed] = await store.claimReadyEffects({
            workerId: 'worker',
            maxCount: 1,
            leaseMs: 100,
            nowMs: Date.now()
        }, decodePersistedALMessageValue);
        expect(claimed.payload).toEqual(effect.payload);
        expect(claimed.status).toBe('running');
    });

    it('rejects corrupt prepared values at every durable-effect read boundary without modifying the row', async () => {
        const { backend, store, state } = createAdmission();
        const msg = createMessage();
        const effect = createEffect(msg);
        const corrupt = {
            ...effect,
            status: 'running',
            leaseOwner: 'worker',
            leaseUntilMs: 1,
            payload: { kind: 'send-prepared', msg, prepared: { id: msg.id }, phase: 'immediate' }
        };
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effect.effectId}`, corrupt);
        });
        await expect(store.claimReadyEffects({
            workerId: 'worker',
            maxCount: 1,
            leaseMs: 100,
            nowMs: Date.now()
        }, decodePersistedALMessageValue)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.peekNextEffectReadyAt(decodePersistedALMessageValue))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.completeEffect(effect.effectId, 'worker', decodePersistedALMessageValue))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.rescheduleEffect({
            effectId: effect.effectId,
            workerId: 'worker',
            retryAtMs: Date.now(),
            lastError: undefined
        }, decodePersistedALMessageValue)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(store.commitBundle({
            senderId: msg.id.senderId,
            mutations: [],
            durableEffects: [{ effectId: effect.effectId, payload: effect.payload }]
        }, decodePersistedALMessageValue)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect(state.data.get(`outbound:effect:${effect.effectId}`)?.value).toEqual(corrupt);
        expect(state.data.has(`outbound:version:${msg.id.senderId}`)).toBe(false);
    });

    it('rejects a corrupt replay from runtime readiness before sending or scheduling a retry', async () => {
        const { backend, store } = createAdmission();
        const msg = createMessage();
        const effect = createEffect(msg);
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effect.effectId}`, {
                ...effect,
                payload: { ...effect.payload, prepared: { id: msg.id } }
            });
        });
        const sent: string[] = [];
        const runtime = createDefaultALOutboundMessageRuntime({
            stores: { admissionStore: store },
            outbox: new InMemoryQueueBox(new Map()),
            decodePreparedMessage: decodeALOutboundPreparedMessage,
            toOutboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessageValue(JSON.parse(entry.resource)),
            planOutgoingMessage: () => ({ persist: false, preparedMessages: [] }),
            sendPreparedMessage: async (message) => {
                sent.push(message.id.msgId);
            }
        });
        try {
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
            expect(sent).toEqual([]);
        }
        finally {
            runtime.dispose();
        }
    });

    it.each(['temporal', 'serialized'])('replays a %s queue entry with the original message and supersedence queue key', async (representation) => {
        const { backend, store } = createAdmission();
        const msg = createMessage();
        const entry = {
            ...QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            key: { topicId: 'chat', resourceId: 'previous-superseded-resource', contextId: 'context' }
        };
        const effect = createEffect(msg);
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effect.effectId}`, {
                ...effect,
                payload: {
                    kind: 'enqueue-outbox',
                    msg,
                    entry: representation === 'serialized' ? JSON.parse(JSON.stringify(entry)) : entry,
                    replaceExisting: true
                }
            });
        });
        const [claimed] = await store.claimReadyEffects({ workerId: 'worker', maxCount: 1, leaseMs: 100, nowMs: Date.now() }, decodeALOutboundPreparedMessage);
        if (claimed.payload.kind !== 'enqueue-outbox') {
            throw new Error('Expected the durable outbox effect');
        }
        expect(claimed.payload.entry.key.resourceId).toBe('previous-superseded-resource');
        expect(claimed.payload.entry.resource).toBe(JSON.stringify(msg));
        expect(claimed.payload.entry.audit.expiryTs).toBeInstanceOf(Temporal.Instant);
        expect(claimed.payload.replaceExisting).toBe(true);
    });

    it.each(['ack-timeout', 'repair-hint', 'nack-retry'])('keeps corruption typed through %s replay', async (kind) => {
        const { backend, store } = createAdmission();
        const msg = createMessage();
        const payload = kind === 'ack-timeout'
            ? { kind, msgId: msg.id.msgId }
            : kind === 'nack-retry'
            ? { kind, msgId: msg.id.msgId, reason: 'not-yet-in-sync' }
            : { kind, msgId: msg.id.msgId, request: { trigger: 'repair', failedPeerIds: [], missingSeqs: [] } };
        const effect = createEffect(msg);
        await backend.write(async (tx) => {
            await tx.set(`outbound:sent:${msg.id.msgId}`, { msgId: msg.id.msgId, msg: { ...msg, payload: {} } });
            await tx.set(`outbound:effect:${effect.effectId}`, { ...effect, payload });
        });
        const runtime = createDefaultALOutboundMessageRuntime({
            stores: { admissionStore: store },
            outbox: new InMemoryQueueBox(new Map()),
            decodePreparedMessage: decodeALOutboundPreparedMessage,
            toOutboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessageValue(JSON.parse(entry.resource)),
            planOutgoingMessage: () => ({ persist: false, preparedMessages: [] }),
            sendPreparedMessage: async () => {
                throw new Error('Corrupt replay must never send');
            }
        });
        try {
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        }
        finally {
            runtime.dispose();
        }
    });

    it('rejects valid prepared messages for a different envelope and malformed WS recipient identities', async () => {
        const msg = createMessage();
        const foreign = { ...msg, targets: { mode: 'unicast', toPeerId: 'foreign-peer' } };
        expect(() => decodeALOutboundPreparedMessage(foreign, msg)).toThrow(TypeError);
        expect(() => decodeWsQueueBoxServerPreparedMessage({ kind: 'recipient', peerId: 'peer', message: msg }, msg)).toThrow(TypeError);
        expect(decodeWsQueueBoxServerPreparedMessage({ kind: 'recipient', peerId: 'peer', connectionId: 'connection', message: msg }, msg))
            .toEqual({ kind: 'recipient', peerId: 'peer', connectionId: 'connection', message: msg });
        expect(() => decodeWsQueueBoxServerPreparedMessage({ kind: 'cluster-local-complete', message: msg }, msg)).not.toThrow();
    });

    it('rejects a prepared transport copy that removes durable relay diagnostics', () => {
        const msg = {
            ...createMessage(),
            diagnostics: { visitedPeerIds: ['relay-self'] }
        };
        const corrupted = {
            ...msg,
            diagnostics: { visitedPeerIds: [] }
        };

        expect(() => decodeALOutboundPreparedMessage(corrupted, msg)).toThrow(TypeError);
    });

    it('rejects a persisted prepared transport target that no longer matches its effect fingerprint', async () => {
        const { backend, store } = createAdmission();
        const msg = createMessage();
        const effect = createEffect(msg);
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effect.effectId}`, {
                ...effect,
                payload: {
                    ...effect.payload,
                    prepared: {
                        ...msg,
                        forwarding: { nextHopPeerIds: ['redirected-peer'] }
                    }
                }
            });
        });

        await expect(store.claimReadyEffects({
            workerId: 'worker',
            maxCount: 1,
            leaseMs: 100,
            nowMs: Date.now()
        }, decodeALOutboundPreparedMessage)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a recomputed prepared fingerprint that no longer matches the durable effect identity', async () => {
        const { backend, store } = createAdmission();
        const msg = createMessage();
        const effect = createEffect(msg);
        const redirected = {
            ...msg,
            forwarding: { nextHopPeerIds: ['redirected-peer'] }
        };
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effect.effectId}`, {
                ...effect,
                payload: {
                    ...effect.payload,
                    prepared: redirected,
                    preparedFingerprint: toALOutboundPreparedFingerprint(redirected)
                }
            });
        });

        await expect(store.claimReadyEffects({
            workerId: 'worker',
            maxCount: 1,
            leaseMs: 100,
            nowMs: Date.now()
        }, decodeALOutboundPreparedMessage)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        {
            label: 'zero-attempt',
            attempts: 0,
            toPendingEffectId: (msgId: string) => toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', 0])
        },
        {
            label: 'foreign-message',
            attempts: 1,
            toPendingEffectId: () => toALOutboundEffectId(['nack-retry', 'foreign-msg', 'not-yet-in-sync', 1])
        }
    ])('rejects a $label not-yet-in-sync retry snapshot', async ({ attempts, toPendingEffectId }) => {
        const { backend, store } = createAdmission();
        const msgId = createMessage().id.msgId;
        await backend.write(async (tx) => {
            await tx.set(`outbound:not-yet-in-sync-retry:${msgId}`, {
                msgId,
                attempts,
                pendingEffectId: toPendingEffectId(msgId)
            });
        });

        await expect(scheduleNotYetInSyncRetry(store, msgId))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a retry snapshot linked to a different effect kind', async () => {
        const { backend, store } = createAdmission();
        const msgId = createMessage().id.msgId;
        const effectId = toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', 1]);
        const nowMs = Date.now();
        await backend.write(async (tx) => {
            await tx.set(`outbound:not-yet-in-sync-retry:${msgId}`, {
                msgId,
                attempts: 1,
                pendingEffectId: effectId
            });
            await tx.set(`outbound:effect:${effectId}`, {
                effectId,
                payload: { kind: 'ack-timeout', msgId },
                status: 'pending',
                attempts: 0,
                retryAtMs: nowMs,
                updatedAtMs: nowMs,
                expireAtTimestamp: nowMs + 60_000
            });
        });

        await expect(scheduleNotYetInSyncRetry(store, msgId))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a durable not-yet-in-sync retry owned by another message', async () => {
        const { backend, store } = createAdmission();
        const msgId = createMessage().id.msgId;
        const effectId = toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', 1]);
        const nowMs = Date.now();
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effectId}`, {
                effectId,
                payload: {
                    kind: 'nack-retry',
                    msgId: 'foreign-msg',
                    reason: 'not-yet-in-sync'
                },
                status: 'pending',
                attempts: 0,
                retryAtMs: nowMs,
                updatedAtMs: nowMs,
                expireAtTimestamp: nowMs + 60_000
            });
        });

        await expect(store.claimReadyEffects({
            workerId: 'worker',
            maxCount: 1,
            leaseMs: 100,
            nowMs
        }, decodePersistedALMessageValue)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { field: 'effectId', value: 'wrong-slot' },
        { field: 'status', value: 'done' },
        { field: 'attempts', value: -1 },
        { field: 'retryAtMs', value: 'tomorrow' },
        { field: 'payload', value: { kind: 'unknown' } }
    ])('rejects invalid effect $field before claiming it', async ({ field, value }) => {
        const { backend, store } = createAdmission();
        const effect = createEffect(createMessage());
        await backend.write(async (tx) => {
            await tx.set(`outbound:effect:${effect.effectId}`, { ...effect, [field]: value });
        });
        await expect(store.claimReadyEffects({
            workerId: 'worker',
            maxCount: 1,
            leaseMs: 100,
            nowMs: Date.now()
        }, decodePersistedALMessageValue)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });
});

function createAdmission() {
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const store = createALOutboundAdmissionStore({
        namespace: 'outbound',
        backend,
        supersedenceTrackTtlMs: 1_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { backend, store, state };
}

async function scheduleNotYetInSyncRetry(
    store: ReturnType<typeof createAdmission>['store'],
    msgId: string
) {
    return await store.scheduleNotYetInSyncRetry({
        senderId: 'sender',
        expectedVersion: undefined,
        msgId,
        maxAttempts: 3,
        expireAtTimestamp: Date.now() + 60_000,
        createEffect: (attempt) => ({
            effectId: toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', attempt]),
            expireAtTimestamp: Date.now() + 60_000,
            payload: { kind: 'nack-retry', msgId, reason: 'not-yet-in-sync' }
        })
    }, decodePersistedALMessageValue);
}

function createMessage() {
    return newALUnicastMessage(
        'sender',
        {
            topicId: 'chat',
            resourceId: 'resource',
            contextId: 'context'
        },
        'peer',
        'chat.text.v1',
        { text: 'hello' }
    );
}

function createEffect(msg: ReturnType<typeof createMessage>) {
    const preparedFingerprint = toALOutboundPreparedFingerprint(msg);
    return {
        effectId: toALOutboundEffectId([
            'send',
            msg.id.msgId,
            'immediate',
            0,
            preparedFingerprint
        ]),
        payload: {
            kind: 'send-prepared' as const,
            msg,
            prepared: msg,
            preparedFingerprint,
            phase: 'immediate' as const
        },
        status: 'pending' as const,
        attempts: 0,
        retryAtMs: 0,
        updatedAtMs: Date.now(),
        expireAtTimestamp: Date.now() + 60_000
    };
}

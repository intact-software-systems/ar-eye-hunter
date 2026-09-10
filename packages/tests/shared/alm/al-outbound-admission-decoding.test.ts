import { Temporal } from '@js-temporal/polyfill';
import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import {
    claimOutboundTestWork,
    peekOutboundWorkReadyAt
} from './outbound-runtime-test-fixture.ts';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundCanonicalKey,
    toALOutboundIdentityEntry,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { decodeALOutboundTransportMessage, toALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundWorkKey, toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';

describe('outbound admission persisted-record validation', () => {
    it('recovers a malformed reservation when persisting its terminal rejection fails', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const admission = createAdmission();
        const { backend, store } = admission;
        const effect = createEffect(createMessage());
        const entry = await writeRawOutboundWork(backend, effect.effectId, {
            ...effect,
            payload: { kind: 'unsupported' }
        });
        vi.spyOn(backend.workQueue, 'releaseEntries').mockRejectedValueOnce(new Error('Terminal write unavailable'));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await runOutboundWorkBatch(admission);
        expect(await backend.workQueue.getItem(entry.key))
            .toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });

        vi.setSystemTime(Date.now() + 10_001);
        await runOutboundWorkBatch(admission);
        expect(await backend.workQueue.getItem(entry.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            resource: entry.resource,
            dequeueAudit: { attempts: 2, nextTs: undefined }
        });
        expect(await peekOutboundWorkReadyAt(backend.workQueue, store.namespace)).toBeUndefined();
    });

    it.each([0, 19, 20])('isolates malformed work at attempt %s while valid work remains claimable', async (attempts) => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const malformed = createEffect(createMessage());
        const malformedEntry = await writeRawOutboundWork(backend, malformed.effectId, malformed);
        const corruptedEntry = {
            ...malformedEntry,
            resource: '{invalid-json',
            status: attempts === 0 ? EntityStatus.NEW : EntityStatus.RESERVED,
            dequeueAudit: {
                attempts,
                startTs: attempts === 0 ? undefined : Temporal.Now.instant().subtract({ seconds: 20 })
            }
        };
        await backend.workQueue.setItem(corruptedEntry.key, corruptedEntry, {
            expireAtTimestamp: Number(corruptedEntry.audit.expiryTs.epochMilliseconds)
        });
        const valid = createEffect(createMessage());
        await writeRawOutboundWork(backend, valid.effectId, valid);

        const sent = await runOutboundWorkBatch(admission);

        expect(sent).toEqual([valid.payload.message.msgId]);
        expect(await backend.workQueue.getItem(corruptedEntry.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            resource: corruptedEntry.resource,
            dequeueAudit: { attempts: attempts + 1, nextTs: undefined }
        });
        expect(await backend.workQueue.getItem(toALOutboundWorkKey('outbound', valid.effectId)))
            .toMatchObject({ status: EntityStatus.COMPLETED });
        expect(await peekOutboundWorkReadyAt(backend.workQueue, store.namespace)).toBeUndefined();
    });

    it('rejects wrong-slot and malformed sent snapshots in point and ordering lookup reads', async () => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const msg = createMessage();
        await backend.write(async (tx) => {
            await tx.set('outbound:sent:wrong-slot', { msgId: msg.id.msgId, msg });
        });

        await expect(store.readSentMessage('wrong-slot')).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await backend.write(async (tx) => {
            await tx.set('outbound:ordering-message:["track",1]', 'wrong-slot');
        });
        await expect(store.readSentMessageByOrdering('track', 1)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        await backend.write(async (tx) => {
            await tx.remove('outbound:sent:wrong-slot');
            await tx.set(`outbound:sent:${msg.id.msgId}`, { msgId: msg.id.msgId, msg: { ...msg, payload: {} } });
        });
        await expect(store.readSentMessage(msg.id.msgId)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects malformed ack state and mismatched control history before mutation', async () => {
        const admission = createAdmission();
        const { backend, store } = admission;
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
        await expect(store.readPendingAck('msg')).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        const msg = createMessage();
        await backend.write(async (tx) => {
            await tx.set(`outbound:control:acks:${msg.id.msgId}`, { kind: 'nacks', values: [] });
        });
        await expect(
            store.readOutgoingMessage({
                msg: msg,
                planner: () => ({ msg: msg, persist: false, preparedMessages: [] }),
                observedCanonicalEntry: undefined,
                intent: 'enqueue'
            })
        )
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it.each([
        { field: 'repairTracking', algo: ['none'] },
        { field: 'repairTracking', algo: ['retransmit'] },
        { field: 'supersedenceTracking', algo: ['none'] },
        { field: 'supersedenceTracking', algo: ['latest-wins'] }
    ])('rejects a persisted $field array algorithm $algo without changing storage', async ({ field, algo }) => {
        const admission = createAdmission();
        const { backend, store, state } = admission;
        const msg = createMessage();
        const effect = createEffect(msg);
        await writeRawOutboundWork(backend, effect.effectId, effect);
        await backend.write(async (tx) => {
            await tx.set(`outbound:sent:${msg.id.msgId}`, {
                msgId: msg.id.msgId,
                reference: effect.payload.message,
                unicastPeerId: 'peer',
                orderingTrackKey: null,
                orderingSeq: null,
                creationExpiry: captureALOutboundCreationExpiry(msg),
                policy: {
                    persist: true,
                    ackTracking: null,
                    retryTracking: null,
                    repairTracking: null,
                    supersedenceTracking: null,
                    [field]: field === 'repairTracking' ? { enabled: true, algo, maxAttempts: 3 } : { enabled: true, algo }
                }
            });
        });
        const before = structuredClone(state.data);

        await expect(store.readSentMessage(msg.id.msgId)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        expect(state.data).toEqual(before);
        expect((await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effect.effectId)))?.status)
            .toBe(EntityStatus.NEW);
    });

    it('decodes a saved prepared message without planning or dropping its persisted content', async () => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const msg = createMessage();
        const effect = createEffect(msg);
        await writeRawOutboundWork(backend, effect.effectId, effect);
        const [claimed] = await claimOutboundTestWork(admission.stores, 1);
        expect(claimed!.payload).toEqual(effect.payload);
        expect(claimed!.entry.status).toBe(EntityStatus.RESERVED);
    });

    it('rejects corrupt prepared values without changing their payload or admitting message state', async () => {
        const admission = createAdmission();
        const { backend, store, state } = admission;
        const msg = createMessage();
        const effect = createEffect(msg);
        const corrupt = {
            ...effect,
            payload: { ...effect.payload, prepared: { id: msg.id } }
        };
        await writeRawOutboundWork(backend, effect.effectId, corrupt);
        await runOutboundWorkBatch(admission);
        expect(await peekOutboundWorkReadyAt(backend.workQueue, store.namespace)).toBeUndefined();
        await expect(store.commitBundle({
            senderId: msg.id.senderId,
            mutations: [],
            durableEffects: [{ effectId: effect.effectId, payload: effect.payload }]
        })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        const persisted = await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effect.effectId));
        expect(persisted?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect(JSON.parse(persisted!.resource).payload).toEqual(corrupt.payload);
        expect(state.data.has(`outbound:version:${msg.id.senderId}`)).toBe(false);
    });

    it('rejects a corrupt replay while runtime readiness sends valid work from the same batch', async () => {
        const admission = createAdmission();
        const { backend } = admission;
        const msg = createMessage();
        const effect = createEffect(msg);
        await writeRawOutboundWork(backend, effect.effectId, {
            ...effect,
            payload: { ...effect.payload, prepared: { id: msg.id } }
        });
        const valid = createEffect(createMessage());
        await writeRawOutboundWork(backend, valid.effectId, valid);
        const sent: string[] = [];
        const runtime = createDefaultALOutboundMessageRuntime({
            stores: admission.stores,
            outbox: new InMemoryQueueBox(new Map()),
            decodePreparedMessage: decodeALOutboundTransportMessage,
            toOutboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessageValue(JSON.parse(entry.resource)),
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] }),
            sendPreparedMessage: async (_message, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage.id.msgId);

                return { status: 'sent' as const };
            }
        });
        try {
            await runtime.ready();
            await runtime.ready();
            expect(sent).toEqual([valid.payload.message.msgId]);
            expect(await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effect.effectId)))
                .toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1 } });
            expect(await backend.workQueue.getItem(toALOutboundWorkKey('outbound', valid.effectId)))
                .toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 1 } });
        }
        finally {
            runtime.dispose();
        }
    });

    it.each(['payload', 'identity'] as const)('rejects a live reference whose canonical %s row is missing', async (missing) => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const effect = createEffect(createMessage());
        await writeRawOutboundWork(backend, effect.effectId, effect);
        await backend.workQueue.removeItem(missing === 'payload' ? effect.canonicalEntry.key : effect.identityEntry.key);
        await runOutboundWorkBatch(admission);
        expect(await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effect.effectId)))
            .toMatchObject({ status: EntityStatus.NON_RETRYABLE });
        expect(await peekOutboundWorkReadyAt(backend.workQueue, store.namespace)).toBeUndefined();
    });

    it.each(['ack-timeout', 'repair-hint', 'nack-retry'])('terminates corrupt %s replay as non-retryable', async (kind) => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const msg = createMessage();
        const payload = kind === 'ack-timeout'
            ? { kind, msgId: msg.id.msgId }
            : kind === 'nack-retry'
            ? { kind, msgId: msg.id.msgId, reason: 'not-yet-in-sync' }
            : { kind, msgId: msg.id.msgId, request: { trigger: 'repair', failedPeerIds: [], missingSeqs: [] } };
        const effect = createEffect(msg);
        await backend.write(async (tx) => {
            await tx.set(`outbound:sent:${msg.id.msgId}`, { msgId: msg.id.msgId, msg: { ...msg, payload: {} } });
            const effectId = kind === 'nack-retry'
                ? toALOutboundEffectId(['nack-retry', msg.id.msgId, 'not-yet-in-sync', 1])
                : effect.effectId;
            await writeRawOutboundWork(backend, effectId, { effectId, payload });
        });
        const runtime = createDefaultALOutboundMessageRuntime({
            stores: admission.stores,
            outbox: new InMemoryQueueBox(new Map()),
            decodePreparedMessage: decodeALOutboundTransportMessage,
            toOutboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessageValue(JSON.parse(entry.resource)),
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] }),
            sendPreparedMessage: async () => {
                throw new Error('Corrupt replay must never send');
            }
        });
        try {
            await runtime.ready();
            const workId = kind === 'nack-retry'
                ? toALOutboundEffectId(['nack-retry', msg.id.msgId, 'not-yet-in-sync', 1])
                : effect.effectId;
            expect(await backend.workQueue.getItem(toALOutboundWorkKey('outbound', workId)))
                .toMatchObject({ status: EntityStatus.NON_RETRYABLE });
        }
        finally {
            runtime.dispose();
        }
    });

    it('rejects valid prepared messages for a different envelope and malformed WS recipient identities', async () => {
        const msg = createMessage();
        const foreign = { ...toALOutboundTransportMessage(msg), targets: { mode: 'unicast', toPeerId: 'foreign-peer' } };
        const prepared = toALOutboundTransportMessage(msg);
        expect(() => decodeALOutboundTransportMessage(foreign, msg)).toThrow(TypeError);
        expect(() => decodeWsQueueBoxServerPreparedMessage({ kind: 'recipient', peerId: 'peer', message: msg }, msg)).toThrow(TypeError);
        expect(decodeWsQueueBoxServerPreparedMessage({ kind: 'recipient', peerId: 'peer', connectionId: 'connection', message: prepared }, msg))
            .toEqual({ kind: 'recipient', peerId: 'peer', connectionId: 'connection', message: prepared });
        expect(() => decodeWsQueueBoxServerPreparedMessage({ kind: 'cluster-local-complete', message: prepared }, msg)).not.toThrow();
    });

    it('rejects a prepared transport copy that removes durable relay diagnostics', () => {
        const msg = {
            ...createMessage(),
            diagnostics: { visitedPeerIds: ['relay-self'] }
        };
        const corrupted = {
            ...toALOutboundTransportMessage(msg),
            diagnostics: { visitedPeerIds: [] }
        };

        expect(() => decodeALOutboundTransportMessage(corrupted, msg)).toThrow(TypeError);
    });

    it('rejects a persisted prepared transport target that no longer matches its effect fingerprint', async () => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const msg = createMessage();
        const effect = createEffect(msg);
        await writeRawOutboundWork(backend, effect.effectId, {
            ...effect,
            payload: {
                ...effect.payload,
                prepared: {
                    ...effect.payload.prepared,
                    forwarding: { nextHopPeerIds: ['redirected-peer'] }
                }
            }
        });

        await runOutboundWorkBatch(admission);
        expect((await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effect.effectId)))?.status)
            .toBe(EntityStatus.NON_RETRYABLE);
    });

    it('rejects a recomputed prepared fingerprint that no longer matches the durable effect identity', async () => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const msg = createMessage();
        const effect = createEffect(msg);
        const redirected = {
            ...effect.payload.prepared,
            forwarding: { nextHopPeerIds: ['redirected-peer'] }
        };
        await writeRawOutboundWork(backend, effect.effectId, {
            ...effect,
            payload: {
                ...effect.payload,
                prepared: redirected,
                preparedFingerprint: toALOutboundPreparedFingerprint(redirected)
            }
        });

        await runOutboundWorkBatch(admission);
        expect((await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effect.effectId)))?.status)
            .toBe(EntityStatus.NON_RETRYABLE);
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
        const admission = createAdmission();
        const { backend, store } = admission;
        const msgId = createMessage().id.msgId;
        await backend.write(async (tx) => {
            await tx.set(`outbound:not-yet-in-sync-retry:${msgId}`, {
                msgId,
                attempts,
                pendingEffectId: toPendingEffectId(msgId)
            });
        });

        await expect(scheduleNotYetInSyncRetry(admission, msgId))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a retry snapshot linked to a different effect kind', async () => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const msgId = createMessage().id.msgId;
        const effectId = toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', 1]);
        await backend.write(async (tx) => {
            await tx.set(`outbound:not-yet-in-sync-retry:${msgId}`, {
                msgId,
                attempts: 1,
                pendingEffectId: effectId
            });
            await writeRawOutboundWork(backend, effectId, {
                effectId,
                payload: { kind: 'ack-timeout', msgId }
            });
        });

        await expect(scheduleNotYetInSyncRetry(admission, msgId))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a durable not-yet-in-sync retry owned by another message', async () => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const msgId = createMessage().id.msgId;
        const effectId = toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', 1]);
        await writeRawOutboundWork(backend, effectId, {
            effectId,
            payload: {
                kind: 'nack-retry',
                msgId: 'foreign-msg',
                reason: 'not-yet-in-sync'
            }
        });

        await runOutboundWorkBatch(admission);
        expect((await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effectId)))?.status)
            .toBe(EntityStatus.NON_RETRYABLE);
    });

    it.each([
        { field: 'effectId', value: 'wrong-slot' },
        { field: 'namespace', value: 'foreign-scope' },
        { field: 'payload', value: { kind: 'unknown' } }
    ])('rejects invalid effect $field at the claimed-work boundary', async ({ field, value }) => {
        const admission = createAdmission();
        const { backend, store } = admission;
        const effect = createEffect(createMessage());
        await writeRawOutboundWork(backend, effect.effectId, { ...effect, [field]: value });
        await runOutboundWorkBatch(admission);
        expect((await backend.workQueue.getItem(toALOutboundWorkKey('outbound', effect.effectId)))?.status)
            .toBe(EntityStatus.NON_RETRYABLE);
    });
});

function createAdmission() {
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'outbound',
        decodePrepared: decodeALOutboundTransportMessage,
        namespace: 'outbound',
        backend,
        supersedenceTrackTtlMs: 1_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { backend, store, state, stores: { admissionStore: store, workQueue: backend.workQueue } };
}

/**
 * Runs one owner batch over this scope's work, the way the runtime's worker does: a row it cannot
 * decode is rejected by the attempt, and a valid sibling in the same batch still runs.
 */
async function runOutboundWorkBatch(
    admission: ReturnType<typeof createAdmission>,
    sent: string[] = []
): Promise<readonly string[]> {
    const runtime = createDefaultALOutboundMessageRuntime({
        stores: admission.stores,
        outbox: new InMemoryQueueBox(new Map()),
        decodePreparedMessage: decodeALOutboundTransportMessage,
        toOutboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessageValue(JSON.parse(entry.resource)),
        planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] }),
        sendPreparedMessage: async (_message, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent' as const };
        }
    });
    try {
        await runtime.ready();
        return sent;
    }
    finally {
        runtime.dispose();
    }
}

async function scheduleNotYetInSyncRetry(
    admission: ReturnType<typeof createAdmission>,
    msgId: string
) {
    const control = createTestALOutboundControlAdmission({ ...admission.stores, nowMs: Date.now });
    return await control.scheduleNotYetInSyncRetry({
        senderId: 'sender',
        expectedVersion: undefined,
        msgId,
        maxAttempts: 3,
        expireAtTimestamp: Date.now() + 60_000,
        retryAtMs: Date.now()
    });
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
        { text: 'hello' },
        { ttlMs: 60_000 }
    );
}

function createEffect(msg: ReturnType<typeof createMessage>) {
    const prepared = toALOutboundTransportMessage(msg);
    const preparedFingerprint = toALOutboundPreparedFingerprint(prepared);
    const canonicalEntry = {
        ...QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        key: toALOutboundCanonicalKey('outbound', msg),
        status: EntityStatus.COMPLETED
    };
    const reference = toALOutboundMessageReference('outbound', canonicalEntry, msg);
    return {
        effectId: toALOutboundEffectId([
            'send',
            msg.id.msgId,
            'immediate',
            'initial',
            0,
            preparedFingerprint
        ]),
        canonicalEntry,
        identityEntry: toALOutboundIdentityEntry(reference, canonicalEntry, captureALOutboundCreationExpiry(msg)),
        payload: {
            kind: 'send-prepared' as const,
            message: reference,
            attemptIdentity: 'initial',
            prepared,
            preparedFingerprint,
            phase: 'immediate' as const
        }
    };
}

async function writeRawOutboundWork(
    backend: InMemoryAdmissionBackend,
    effectId: string,
    raw: Readonly<{
        namespace?: unknown;
        effectId: unknown;
        payload: unknown;
        canonicalEntry?: ReturnType<typeof createEffect>['canonicalEntry'];
        identityEntry?: ReturnType<typeof createEffect>['identityEntry'];
    }>
) {
    if (raw.canonicalEntry) {
        await backend.workQueue.enqueueIfAbsent(raw.canonicalEntry);
    }
    if (raw.identityEntry) {
        await backend.workQueue.enqueueIfAbsent(raw.identityEntry);
    }
    const entry = toResourceEntryWithKey(
        toALOutboundWorkKey('outbound', effectId),
        toALOutboundWorkType('outbound'),
        { namespace: raw.namespace ?? 'outbound', effectId: raw.effectId, payload: raw.payload },
        Temporal.Instant.fromEpochMilliseconds(
            typeof raw.payload === 'object' && raw.payload !== null && 'message' in raw.payload && typeof raw.payload.message === 'object' &&
                raw.payload.message !== null && 'expiresAtMs' in raw.payload.message
                ? Number(raw.payload.message.expiresAtMs)
                : Date.now() + 60_000
        )
    );
    await backend.workQueue.setItem(entry.key, entry, { expireAtTimestamp: Date.now() + 60_000 });
    return entry;
}

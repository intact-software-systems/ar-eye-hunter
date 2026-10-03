import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALNackControlMessage
} from '@shared/al-contracts/al-control.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import {
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    toALOutboundControlHistoryKey,
    toALOutboundMessageOwnerKey,
    toALOutboundPendingAckKey,
    toALOutboundSentMessageKey,
    toALOutboundVersionKey
} from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import {
    createALOutboundAdmissionStore,
    createVolatileALOutboundAdmissionStore
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    toOutboundTestAck,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const NAMESPACE = 'volatile-retention';
const SERVER_PEER_ID = 'ws-server';

interface ObservedOutboundPair {
    readonly state: ALAdmissionMemoryState;
    readonly stores: ALVolatileOutboundRuntimeStores<OutboundTestPayload>;
}

describe('the rows a volatile outbound send keeps (D74)', () => {
    it('keeps the owner and sent rows for the message deadline plus the receipt grace', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('volatile');
        const runtime = createVolatileSendRuntime(pair.stores, []);
        const message = createOutboundMessage('volatile-rows', { ttlMs: 1_000 });

        await enqueueOutboundOrThrow(runtime, message);

        const keptUntilMs = readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS;
        expect(readRowExpiries(pair.state, message)).toEqual({
            owner: keptUntilMs,
            sent: keptUntilMs
        });
    });

    it('keeps the owner and sent rows of a durable send for the repository retention, as before', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('durable');
        const runtime = createDefaultOutboundTestRuntime({
            stores: pair.stores,
            planOutgoingMessage: (msg) => ({ ...planSend(msg), lane: 'durable' }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('durable-rows', { ttlMs: 1_000 });
        const admittedAtMs = Date.now();

        await enqueueOutboundOrThrow(runtime, message);

        const keptUntilMs = admittedAtMs + 60 * 60_000;
        expect(readRowExpiries(pair.state, message)).toEqual({
            owner: keptUntilMs,
            sent: keptUntilMs
        });
    });

    it('answers a server refusal that arrives after the deadline but inside the receipt grace', async () => {
        useFakeDate();
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createVolatileSendRuntime(
            createObservedOutboundPair('volatile').stores,
            settlements
        );
        const message = createOutboundMessage('late-inside-grace', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        vi.setSystemTime(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS - 1);

        expect(await runtime.acceptControlMessage(toServerRefusal(message), 'trusted-server'))
            .toEqual({ kind: 'committed' });
        expect(settlements.filter((settlement) => settlement.kind === 'relay-rejected')).toEqual([
            expect.objectContaining({
                msgId: message.id.msgId,
                relayRejection: { relay: 'trusted-server', reason: 'unauthorized' }
            })
        ]);
    });

    it('drops a server refusal that arrives once the grace has passed, as a control about an unknown message', async () => {
        useFakeDate();
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createVolatileSendRuntime(
            createObservedOutboundPair('volatile').stores,
            settlements
        );
        const message = createOutboundMessage('late-past-grace', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        vi.setSystemTime(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS);

        expect(await runtime.acceptControlMessage(toServerRefusal(message), 'trusted-server'))
            .toEqual({
                kind: 'rejected',
                reason: 'AL control has no retained outbound message obligation'
            });
        expect(settlements.filter((settlement) => settlement.kind === 'relay-rejected')).toEqual(
            []
        );
    });
});

/** Fakes only the clock the rows are stamped with; the owner's rounds keep their real timers. */
function useFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
}

/** A memory pair whose admission map the test reads back: each row with the expiry it was written with. */
function createObservedOutboundPair(durability: 'durable' | 'volatile'): ObservedOutboundPair {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const input = {
        nowMs: Date.now,
        namespace: NAMESPACE,
        canonicalScope: NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        decodePrepared: decodeOutboundTestPayload
    };
    return {
        state,
        stores: {
            admissionStore: durability === 'volatile'
                ? createVolatileALOutboundAdmissionStore(input, 'volatile')
                : createALOutboundAdmissionStore(input),
            workQueue: backend.workQueue,
            evictExpired: () => backend.evictExpired(),
            budget: undefined
        }
    };
}

function createVolatileSendRuntime(
    volatileStores: ALVolatileOutboundRuntimeStores<OutboundTestPayload>,
    settlements: ALDeliverySettlement[]
): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores: createDefaultOutboundTestStores(),
        volatileStores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend,
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
}

function planSend(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
    return { msg, dropReasonCode: undefined, lane: 'volatile', preparedMessages: [{ kind: 'send' }] };
}

function readDeadlineMs(message: ALMessage): number {
    const deadlineAtMs = message.constraints?.expiresAtMs;
    if (deadlineAtMs === undefined) {
        throw new Error('The fixture message names its deadline');
    }
    return deadlineAtMs;
}

function readRowExpiries(
    state: ALAdmissionMemoryState,
    message: ALMessage
): Readonly<{ owner: number | undefined; sent: number | undefined; }> {
    return {
        owner: state.data.get(toALOutboundMessageOwnerKey(NAMESPACE, message.id.msgId))
            ?.expireAtTimestamp,
        sent: state.data.get(toALOutboundSentMessageKey(NAMESPACE, message.id.msgId))
            ?.expireAtTimestamp
    };
}

/** The trusted server refusing a message it holds no receipt row for: the owner and sent rows decide it. */
function toServerRefusal(message: ALMessage): ALMessage {
    return newALNackControlMessage(
        { v: 2, msgId: `refusal-${message.id.msgId}`, senderId: SERVER_PEER_ID, ts: Date.now() },
        {
            fromPeerId: SERVER_PEER_ID,
            toPeerId: message.id.senderId,
            msgId: message.id.msgId,
            reason: 'unauthorized',
            observedAtEpochMs: Date.now()
        }
    );
}

describe('the control rows a volatile outbound send keeps (D74)', () => {
    it('keeps a completed receipt row and its acknowledgement history for the deadline plus the receipt grace', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('volatile');
        const runtime = createDefaultOutboundTestRuntime({
            stores: createDefaultOutboundTestStores(),
            volatileStores: pair.stores,
            planOutgoingMessage: (msg) => ({
                ...planSend(msg),
                ackTracking: trackOutboundTestAcks(['peer-1'])
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('acknowledged-rows', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        expect(await runtime.acceptControlMessage(toOutboundTestAck(message, 'peer-1'), 'peer'))
            .toEqual({ kind: 'committed' });

        const keptUntilMs = readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS;
        expect(readControlRowExpiries(pair.state, message)).toEqual({
            receipt: keptUntilMs,
            acks: keptUntilMs
        });
    });

    it('keeps the per-origin version row for an hour on the volatile pair: it fences every commit of that origin', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('volatile');
        const runtime = createReceiptedVolatileSendRuntime(pair.stores, []);
        const message = createOutboundMessage('version-row', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);
        const acknowledgedAtMs = Date.now();

        expect(await runtime.acceptControlMessage(toOutboundTestAck(message, 'peer-1'), 'peer'))
            .toEqual({ kind: 'committed' });

        expect(pair.state.data.get(toALOutboundVersionKey(NAMESPACE, message.id.senderId))?.expireAtTimestamp)
            .toBe(acknowledgedAtMs + 60 * 60_000);
    });

    it('keeps them for the ephemeral TTL on the durable pair, as before', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('durable');
        const runtime = createDefaultOutboundTestRuntime({
            stores: pair.stores,
            planOutgoingMessage: (msg) => ({
                ...planSend(msg),
                lane: 'durable',
                ackTracking: trackOutboundTestAcks(['peer-1'])
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('acknowledged-durable-rows', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);
        const acknowledgedAtMs = Date.now();

        expect(await runtime.acceptControlMessage(toOutboundTestAck(message, 'peer-1'), 'peer'))
            .toEqual({ kind: 'committed' });

        const keptUntilMs = acknowledgedAtMs + 30 * 60_000;
        expect(readControlRowExpiries(pair.state, message)).toEqual({
            receipt: keptUntilMs,
            acks: keptUntilMs
        });
    });
});

/** The receipt row, which the completing ACK leaves as its final snapshot, and the ACK history beside it. */
function readControlRowExpiries(
    state: ALAdmissionMemoryState,
    message: ALMessage
): Readonly<{ receipt: number | undefined; acks: number | undefined; }> {
    const { msgId, senderId } = message.id;
    return {
        receipt: state.data.get(
            toALOutboundPendingAckKey({ namespace: NAMESPACE, originPeerId: senderId, msgId })
        )
            ?.expireAtTimestamp,
        acks: state.data.get(toALOutboundControlHistoryKey(NAMESPACE, 'acks', msgId))
            ?.expireAtTimestamp
    };
}

describe('a peer ACK that reaches a volatile send after its deadline (D74)', () => {
    it('refuses it as late inside the receipt grace and states no settlement, so an expired handle stays expired', async () => {
        useFakeDate();
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createReceiptedVolatileSendRuntime(createObservedOutboundPair('volatile').stores, settlements);
        const message = createOutboundMessage('late-ack-inside-grace', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        vi.setSystemTime(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS - 1);

        expect(await runtime.acceptControlMessage(toOutboundTestAck(message, 'peer-1'), 'peer')).toEqual({
            kind: 'rejected',
            reason: 'AL acknowledgement arrived after its message deadline; ' +
                'AL acknowledgement confirms no peer of the pending outbound receipt'
        });
        expect(settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([]);
    });

    it('refuses it as a control about a message it no longer holds once the grace has passed', async () => {
        useFakeDate();
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createReceiptedVolatileSendRuntime(createObservedOutboundPair('volatile').stores, settlements);
        const message = createOutboundMessage('late-ack-past-grace', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        vi.setSystemTime(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS);

        expect(await runtime.acceptControlMessage(toOutboundTestAck(message, 'peer-1'), 'peer')).toEqual({
            kind: 'rejected',
            reason: 'AL control has no retained outbound message obligation'
        });
        expect(settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([]);
    });
});

function createReceiptedVolatileSendRuntime(
    volatileStores: ALVolatileOutboundRuntimeStores<OutboundTestPayload>,
    settlements: ALDeliverySettlement[]
): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores: createDefaultOutboundTestStores(),
        volatileStores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({ ...planSend(msg), ackTracking: trackOutboundTestAcks(['peer-1']) }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
}

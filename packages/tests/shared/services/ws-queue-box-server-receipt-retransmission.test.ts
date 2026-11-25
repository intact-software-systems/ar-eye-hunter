import { describe, expect, it } from 'vitest';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import type { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsCapturedRecipientEligibilityFilters } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';

import { createDelegatingALAdmissionWorkBackend } from '../alm/create-delegating-al-admission-work-backend.ts';
import { createWorkerHold } from '../alm/create-worker-hold.ts';
import { holdALAdmissionWrite } from '../alm/hold-al-admission-write.ts';
import {
    countCopies,
    createReceiptClusterState,
    createReceiptInstanceStores,
    createReceiptOutbox,
    createReceiptServer,
    installClock,
    MEMORY_POLL_TIMEOUT_MS,
    pollRowEnded,
    readOriginTerminalReceipt,
    receiverAck,
    roomMessage,
    type ReceiptClock,
    type ReceiptServerInstance,
    type RowEndedPoll
} from './ws-queue-box-server-receipt-fixture.ts';

const MSG = 'room-message-1';
const ORIGIN = 'o';
const REF = { originPeerId: ORIGIN, msgId: MSG };
/** The ack timeout an at-least-once message resolves to: the server row's retry window. */
const ACK_TIMEOUT_MS = 2_000;
/** Long enough that the head outlives every retry window a case reaches. */
const LIFETIME_MS = 30_000;
const SNAPSHOT_VERSION = 7;

interface RetransmissionServer extends ReceiptServerInstance {
    readonly outbox: InMemoryQueueBox;
    /** The test's own reader of the receipt record the server counts in. */
    readonly record: ALReceiptRecord;
    /** The test's own reader of the server's outbound admission state, where its pending row for the message lives. */
    readonly store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;
}

/** A case's own backend over the base one the server would use; the base is built over state the helper owns. */
type BackendWrapper = (base: ALAdmissionWorkBackend) => ALAdmissionWorkBackend;

interface RetransmissionServerOptions {
    /** Undefined: the outbound owner writes through the base backend. */
    readonly outboundBackend: BackendWrapper | undefined;
    /** Undefined: the receipt record writes through the base backend. */
    readonly recordBackend: BackendWrapper | undefined;
    readonly capturedRecipientEligibilityFilters: WsCapturedRecipientEligibilityFilters | undefined;
}

describe('a receipt retry of a client\'s outbox-fanned send', () => {
    it('resends a client\'s outbox-fanned send only to the recipient that has not confirmed', async () => {
        // The server's row learns only the terminal receipt, so until the retry read the record a retry inside the
        // window resent to every expected recipient, the one that confirmed included.
        const clock = installClock();
        const server = await createRetransmissionServer(clock, {
            outboundBackend: undefined,
            recordBackend: undefined,
            capturedRecipientEligibilityFilters: undefined
        });
        await admitRoomMessage(server, clock, { lifetimeMs: LIFETIME_MS, dequeueDelayMs: 0 });
        await server.service.acceptIncomingMessage(receiverAck({ msgId: MSG, originPeerId: ORIGIN, recipient: 'r1', nowMs: clock.nowMs }), 'r1');

        clock.nowMs += ACK_TIMEOUT_MS + 1;
        await expect.poll(async () => {
            await server.engine.executeOnce();
            return countCopies(server.sockets.r2, MSG);
        }).toBe(2);
        await pollRetrySettled(server);

        expect([countCopies(server.sockets.r1, MSG), countCopies(server.sockets.r2, MSG)]).toEqual([1, 2]);
    });

    it('records a recipient the retry drops outside, and resends to nobody that confirmed', async () => {
        // The same with a drop: until the retry read the record it recorded r2 outside and still resent to r1, which
        // had confirmed.
        const clock = installClock();
        const left = new Set<string>();
        const keepAll = async ({ candidateSessionIds }: { readonly candidateSessionIds: readonly string[]; }) => candidateSessionIds;
        const server = await createRetransmissionServer(clock, {
            outboundBackend: undefined,
            recordBackend: undefined,
            capturedRecipientEligibilityFilters: {
                durable: async ({ candidateSessionIds }) => candidateSessionIds.filter((sessionId) => !left.has(sessionId)),
                local: keepAll,
                socket: keepAll
            }
        });
        await admitRoomMessage(server, clock, { lifetimeMs: LIFETIME_MS, dequeueDelayMs: 0 });
        await server.service.acceptIncomingMessage(receiverAck({ msgId: MSG, originPeerId: ORIGIN, recipient: 'r1', nowMs: clock.nowMs }), 'r1');

        left.add('r2');
        clock.nowMs += ACK_TIMEOUT_MS + 1;
        await expect.poll(async () => {
            await server.engine.executeOnce();
            return readOriginTerminalReceipt([server.sockets.o], MSG)?.phase;
        }).toBe('complete');
        await pollRetrySettled(server);

        expect((await server.record.read(REF)).right?.head).toMatchObject({
            phase: 'complete',
            confirmedRecipientPeerIds: ['r1'],
            outsideAudienceRecipientPeerIds: ['r2']
        });
        expect([countCopies(server.sockets.r1, MSG), countCopies(server.sockets.r2, MSG)]).toEqual([1, 1]);
    });

    it('sends nothing more once the receipt has ended while the row\'s timer is still due', async () => {
        // Pins a `timed-out` head whose terminal receipt has not yet reached the row retransmitting once more.
        const clock = installClock();
        const hold = createWorkerHold();
        let armed = false;
        const server = await createRetransmissionServer(clock, {
            outboundBackend: (base) => {
                const held = holdALAdmissionWrite(base, hold);
                return createDelegatingALAdmissionWorkBackend(base, {
                    write: (operation, executionExpiresAtMs) => (armed ? held : base).write(operation, executionExpiresAtMs)
                });
            },
            recordBackend: undefined,
            capturedRecipientEligibilityFilters: undefined
        });
        // A send that names no deadline opens its head at its ACK timeout; the row's first window opens later, at its
        // dequeue, so the head ends first.
        const admittedAtMs = clock.nowMs;
        await admitRoomMessage(server, clock, { lifetimeMs: undefined, dequeueDelayMs: ACK_TIMEOUT_MS / 4 });
        await server.service.acceptIncomingMessage(receiverAck({ msgId: MSG, originPeerId: ORIGIN, recipient: 'r1', nowMs: clock.nowMs }), 'r1');
        const copiesBeforeTheEnd = countCopies(server.sockets.r2, MSG);
        const attemptsBeforeTheTimer = (await server.store.readReceiptState(REF))?.attempts;
        expect(attemptsBeforeTheTimer).toBeDefined();
        if (attemptsBeforeTheTimer === undefined) {
            throw new Error('The server has no receipt row for the message');
        }

        let arrived = false;
        void hold.arrived.then(() => {
            arrived = true;
        });
        armed = true;
        try {
            clock.nowMs = admittedAtMs + ACK_TIMEOUT_MS;
            await expect.poll(async () => {
                await server.engine.executeOnce();
                return arrived;
            }).toBe(true);
            expect((await server.record.read(REF)).right?.head.phase).toBe('timed-out');

            clock.nowMs = admittedAtMs + ACK_TIMEOUT_MS / 4 + ACK_TIMEOUT_MS;
            await expect.poll(async () => {
                await server.engine.executeOnce();
                return (await server.store.readReceiptState(REF))?.attempts;
            }).toBe(attemptsBeforeTheTimer + 1);
            await pollRetrySettled(server);
            expect(countCopies(server.sockets.r2, MSG)).toBe(copiesBeforeTheEnd);

            hold.release();
            await pollRowEnded(toRowEndedPoll(server));
        }
        finally {
            hold.release();
        }
    });

    it('ends at the row\'s next window a receipt the record counted complete whose end was lost', async () => {
        // Pins a head left open with a complete tally when its `end` failed after the last count committed: the
        // retry narrowed to nobody and planned nothing, so nothing ended the receipt before the row's budget ran out.
        const clock = installClock();
        const failing = { armed: false, writes: 0 };
        const server = await createRetransmissionServer(clock, {
            outboundBackend: undefined,
            // Once armed, the last ACK's count is the record's first write and its `end` the second.
            recordBackend: (base) =>
                createDelegatingALAdmissionWorkBackend(base, {
                    write: async (operation, executionExpiresAtMs) => {
                        if (failing.armed && ++failing.writes === 2) {
                            throw new Error('Receipt record store unavailable');
                        }
                        return await base.write(operation, executionExpiresAtMs);
                    }
                }),
            capturedRecipientEligibilityFilters: undefined
        });
        await admitRoomMessage(server, clock, { lifetimeMs: LIFETIME_MS, dequeueDelayMs: 0 });
        await server.service.acceptIncomingMessage(receiverAck({ msgId: MSG, originPeerId: ORIGIN, recipient: 'r1', nowMs: clock.nowMs }), 'r1');
        failing.armed = true;
        await expect(
            server.service.acceptIncomingMessage(receiverAck({ msgId: MSG, originPeerId: ORIGIN, recipient: 'r2', nowMs: clock.nowMs }), 'r2')
        ).rejects.toThrow('Receipt record store unavailable');
        expect(failing.writes).toBe(2);
        expect((await server.record.read(REF)).right).toMatchObject({ head: { phase: 'open' }, tally: { complete: true } });

        clock.nowMs += ACK_TIMEOUT_MS + 1;
        await expect.poll(async () => {
            await server.engine.executeOnce();
            return (await server.record.read(REF)).right?.head.phase;
        }).toBe('complete');
        await expect.poll(async () => {
            await server.engine.executeOnce();
            return readOriginTerminalReceipt([server.sockets.o], MSG)?.phase;
        }).toBe('complete');
        await pollRowEnded(toRowEndedPoll(server));
        await pollRetrySettled(server);

        expect((await server.record.read(REF)).right?.head).toMatchObject({ confirmedRecipientPeerIds: ['r1', 'r2'] });
        expect([countCopies(server.sockets.r1, MSG), countCopies(server.sockets.r2, MSG)]).toEqual([1, 1]);
    });
});

/** One server whose router fans the room message out through its own outbox to r1 and r2, as production does. */
async function createRetransmissionServer(clock: ReceiptClock, options: RetransmissionServerOptions): Promise<RetransmissionServer> {
    const nowMs = () => clock.nowMs;
    const outbox = createReceiptOutbox(clock);
    const state = createInMemoryALAdmissionState(outbox);
    const stores = createReceiptInstanceStores(createReceiptClusterState(nowMs), nowMs);
    const server = await createReceiptServer({
        ...stores,
        inboundVolatileStores: undefined,
        receiptRecordStores: {
            ...stores.receiptRecordStores,
            backend: options.recordBackend?.(stores.receiptRecordStores.backend) ?? stores.receiptRecordStores.backend
        },
        outboundBackend: options.outboundBackend?.(new InMemoryAdmissionBackend(state, nowMs)),
        capturedRecipientEligibilityFilters: options.capturedRecipientEligibilityFilters,
        receiptObserver: undefined,
        outbox,
        state,
        peerIds: [ORIGIN, 'r1', 'r2'],
        recorder: undefined,
        nowMs
    });
    server.service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? { authorized: true, roomAudience: { recipientPeerIds: [ORIGIN, 'r1', 'r2'], snapshotVersion: SNAPSHOT_VERSION } }
                : { authorized: true }
    });
    server.service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            await server.service.enqueueOutboxIfAbsent(message, {
                admittedAudience: ['r1', 'r2'],
                admittedConnectionGenerationIds: undefined,
                recipientScope: undefined
            });
        }
    });
    const store = createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        outboundBackend: new InMemoryAdmissionBackend(state, nowMs)
    }).admissionStore;
    return { ...server, outbox, record: new ALReceiptRecord({ ...stores.receiptRecordStores, nowMs }), store };
}

/** `lifetimeMs` undefined: the message names no deadline. The dequeue, and with it the row's first window, waits `dequeueDelayMs`. */
async function admitRoomMessage(
    server: RetransmissionServer,
    clock: ReceiptClock,
    timing: { readonly lifetimeMs: number | undefined; readonly dequeueDelayMs: number; }
): Promise<void> {
    const message: ALMessage = roomMessage({ msgId: MSG, originPeerId: ORIGIN, nowMs: clock.nowMs, lifetimeMs: timing.lifetimeMs ?? 0 });
    const sent = timing.lifetimeMs === undefined ? { ...message, constraints: undefined } : message;
    expect((await server.service.acceptIncomingMessage(sent, ORIGIN)).right?.kind).toBe('admitted');
    clock.nowMs += timing.dequeueDelayMs;
    await expect.poll(async () => {
        await server.engine.executeOnce();
        return [countCopies(server.sockets.r1, MSG), countCopies(server.sockets.r2, MSG)];
    }).toEqual([1, 1]);
}

/** Each poll runs the engine once, so the terminal receipt reaches the server's row. */
function toRowEndedPoll(server: RetransmissionServer): RowEndedPoll {
    return {
        store: server.store,
        msgId: MSG,
        advance: async () => {
            await server.engine.executeOnce();
        },
        timeoutMs: MEMORY_POLL_TIMEOUT_MS
    };
}

/** Every repair hint the retry wrote has run, and every send a retransmission prepared has been made. */
async function pollRetrySettled(server: RetransmissionServer): Promise<void> {
    await expect.poll(async () => {
        await server.engine.executeOnce();
        const rows = await Promise.all((await server.outbox.getAllKeys()).map((key) => server.outbox.getItem(key)));
        const work = await Promise.all(
            rows.flatMap((row) => row?.key.topicId === 'AL_OUTBOUND' ? [row] : []).map(async (row) => ({
                kind: (await server.store.readWorkSnapshot(row, undefined)).payload.kind,
                status: row.status
            }))
        );
        const retryWork = work.filter(({ kind }) => kind === 'repair-hint' || kind === 'send-prepared');
        return retryWork.some(({ kind }) => kind === 'repair-hint') &&
            retryWork.every(({ status }) => status === EntityStatus.COMPLETED);
    }).toBe(true);
}

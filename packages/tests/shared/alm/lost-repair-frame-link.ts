import { expect, onTestFinished, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALPersistedInboundEffect } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { reconstructALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';

import '../../setup-browser-indexeddb.ts';
import { ORIGIN_ROOM } from '../multicast/rtc-origin-overlay-fixture.ts';
import { readInboundTestWorkDueAtMs } from '../wait-for-al-inbound-work.ts';
import {
    createInboundTestRuntime,
    createInboundTestStores,
    readInboundTestWorkRows,
    runInboundWorkDueNow,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import {
    createServerReceipt,
    createWsClientCarrierStores,
    createWsClientSender,
    drainOutboundWorkDueNow,
    peekOutboundWorkReadyAt,
    type WsClientCarrierStoreKind
} from './outbound-runtime-test-fixture.ts';

/** The WS client's session, and the WS server it names as its one hop, as `WsQueueBoxClientService` composes it. */
const SESSION_ID = 'origin';
const SERVER_PEER_ID = 'server';
const LINK_START_MS = Date.UTC(2026, 10, 19, 12);
/** The rounds one `advanceTo` may pass frames and controls back and forth before the link is quiet. */
const LINK_EXCHANGE_LIMIT = 20;
const WS_CLIENT_SOURCE: ALInboundMessageRuntime.Source = {
    kind: 'ws-client',
    peerId: SESSION_ID,
    authenticatedScope: { applicationId: ORIGIN_ROOM.applicationId, workspaceId: ORIGIN_ROOM.workspaceId }
};

/** One frame the sender wrote to its socket, and how many copies of its sequence the link has carried by then. */
export interface LossyLinkFrame {
    readonly seq: number | undefined;
    /** 1 for a sequence's first frame, 2 for the frame that writes it again, and so on. */
    readonly copy: number;
    readonly message: ALMessage;
}

export interface LossyLinkInput {
    /** True keeps the frame from the receiver: it left the sender's socket and was lost in transit. */
    readonly drop: (frame: LossyLinkFrame) => boolean;
    /**
     * When, in ms after the link's start, a frame `drop` keeps reaches the receiver; absent, or `undefined` for a frame,
     * the link carries it at once. A held frame arrives after the receiver's work due at that instant has run.
     */
    readonly holdUntilMs?: (frame: LossyLinkFrame) => number | undefined;
}

export interface LossyLink {
    /** Admits each name in order as one ordered room send, and runs the sender's work for them. */
    send(names: readonly string[], ack: ALAckMode): Promise<void>;
    /** Moves the one clock both ends read to `ms` after the link's start and runs both ends until neither has work due. */
    advanceTo(ms: number): Promise<void>;
    /** The `name` of each message the receiver dispatched, in dispatch order. */
    readonly delivered: readonly string[];
    /** How many frames of `seq` the sender wrote, dropped or not. */
    framesOf(seq: number): number;
    /** Every control the receiver sent toward the sender, in send order. */
    readonly controls: readonly ALMessage[];
    /** When either end next has work to run, or a held frame next arrives; none once nothing is left to happen. */
    readNextDueAtMs(): Promise<number | undefined>;
    /** Every row the receiver has still to run. */
    readPendingReceiverWork(): Promise<readonly ALPersistedInboundEffect[]>;
}

/** A frame the link carries later, and when it reaches the receiver. */
interface HeldFrame {
    readonly message: ALMessage;
    readonly arrivesAtMs: number;
}

/**
 * A WS client's sender and a receiver standing for its server, wired through a link that loses what `drop` names and
 * delays what `holdUntilMs` names. Every control the receiver sends reaches the sender, and the server answers each
 * receipted frame that reaches it `admitted`, naming nobody; one fake clock drives both.
 */
export function createLossyLink(store: WsClientCarrierStoreKind, input: LossyLinkInput): LossyLink {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LINK_START_MS);
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const frames: LossyLinkFrame[] = [];
    const inFlight: ALMessage[] = [];
    const held: HeldFrame[] = [];
    const senderStores = createWsClientCarrierStores(SESSION_ID, store);
    const write = (message: ALMessage): void => {
        const seq = message.ordering?.seq;
        const frame = { seq, copy: frames.filter((written) => written.seq === seq).length + 1, message };
        frames.push(frame);
        if (input.drop(frame)) {
            return;
        }
        const heldUntilMs = input.holdUntilMs?.(frame);
        if (heldUntilMs === undefined) {
            inFlight.push(message);
            return;
        }
        held.push({ message, arrivesAtMs: LINK_START_MS + heldUntilMs });
    };
    const sender = createWsClientSender({
        stores: senderStores,
        sendPreparedMessage: async (prepared, _phase, lifecycle) => {
            write(reconstructALOutboundTransportMessage(prepared, lifecycle.canonicalMessage));
            return { status: 'sent', submissionAttempted: true };
        }
    });
    const receiver = createLinkReceiver(store);
    let forwardedControls = 0;
    const exchange = async (): Promise<void> => {
        for (let round = 0; round < LINK_EXCHANGE_LIMIT; round += 1) {
            const receipts: ALMessage[] = [];
            // One frame at a time, its work drained first: a completion that loses its commit to the next arrival's
            // admission is dispatched again, at least once (al-inbound-release-promotion.test.ts states it).
            for (const frame of inFlight.splice(0)) {
                await receiver.runtime.admitIncomingMessage(toWireMessage(frame), WS_CLIENT_SOURCE);
                await runInboundWorkDueNow(receiver);
                if (frame.delivery !== undefined && frame.delivery.ack !== 'none') {
                    receipts.push(createServerReceipt(frame, 'admitted', []));
                }
            }
            await runInboundWorkDueNow(receiver);
            inFlight.push(...takeArrivedFrames(held));
            const receiverControls = receiver.controlSends.flat().slice(forwardedControls);
            forwardedControls += receiverControls.length;
            const controls = [...receipts, ...receiverControls];
            for (const control of controls) {
                await sender.acceptControlMessage(toWireMessage(control), 'peer');
            }
            await drainOutboundWorkDueNow(sender, senderStores);
            if (inFlight.length === 0 && controls.length === 0) {
                return;
            }
        }
    };
    const readNextDueAtMs = async (): Promise<number | undefined> => {
        const due = [
            await readInboundTestWorkDueAtMs(receiver.stores.workQueue),
            await peekOutboundWorkReadyAt(senderStores.workQueue, senderStores.admissionStore.namespace),
            ...held.map((frame) => frame.arrivesAtMs)
        ].filter((dueAtMs) => dueAtMs !== undefined);
        return due.length === 0 ? undefined : Math.min(...due);
    };
    return {
        send: async (names, ack) => {
            for (const name of names) {
                const result = await sender.enqueueIfAbsent(createOrderedRoomBroadcast(name, ack));
                expect(result.verdict.kind, result.reason).toBe('admitted');
            }
            await drainOutboundWorkDueNow(sender, senderStores);
            await exchange();
        },
        // Each due time on the way is reached in turn, so work that comes due between two calls runs when it is due.
        advanceTo: async (ms) => {
            const targetMs = LINK_START_MS + ms;
            for (let nextDueAtMs = await readNextDueAtMs(); nextDueAtMs !== undefined && nextDueAtMs <= targetMs;) {
                vi.setSystemTime(Math.max(Date.now(), nextDueAtMs));
                await exchange();
                const followingDueAtMs = await readNextDueAtMs();
                nextDueAtMs = followingDueAtMs !== undefined && followingDueAtMs > Date.now() ? followingDueAtMs : undefined;
            }
            vi.setSystemTime(targetMs);
            await exchange();
        },
        get delivered() {
            return receiver.deliveredMessages.map((message) => (JSON.parse(message.payload.resource) as { name: string; }).name);
        },
        framesOf: (seq) => frames.filter((frame) => frame.seq === seq).length,
        get controls() {
            return receiver.controlSends.flat();
        },
        readNextDueAtMs,
        readPendingReceiverWork: async () =>
            (await readInboundTestWorkRows(receiver.stores)).filter((effect) => NOT_COMPLETED_RETRYABLE_STATUSES.has(effect.entry.status))
    };
}

/** Removes and returns, in the order they were held, the frames whose time has come. */
function takeArrivedFrames(held: HeldFrame[]): readonly ALMessage[] {
    const arrived = held.filter((frame) => frame.arrivesAtMs <= Date.now());
    held.splice(0, held.length, ...held.filter((frame) => frame.arrivesAtMs > Date.now()));
    return arrived.map((frame) => frame.message);
}

/** The server's inbound owner: it orders every track it admits, and its renewal stretch is drawn as 1. */
function createLinkReceiver(store: WsClientCarrierStoreKind): InboundTestRuntime {
    return createInboundTestRuntime({
        stores: createInboundTestStores({
            namespace: `lossy-link-${crypto.randomUUID()}`,
            storage: store,
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        carrier: 'ws',
        effectWorkerId: `al-inbound:lossy-link-${crypto.randomUUID()}`,
        selfPeerId: SERVER_PEER_ID,
        orderingObserver: 'every-track',
        random: () => 0
    });
}

/**
 * A message as the other end receives it: the WS carriers send `JSON.stringify` of it (`JsonWebSocketClient.send`,
 * `JsonWebSocketServer.encode`), parse the text with `JSON.parse`, and decode it with `decodeALMessageValue`
 * (`WsQueueBoxServerService.acceptIncomingMessage`, `WsQueueBoxClientService.acceptIncomingMessage`).
 */
function toWireMessage(message: ALMessage): ALMessage {
    const decoded = decodeALMessageValue(JSON.parse(JSON.stringify(message)));
    if (decoded.left) {
        throw new Error(`The receiving carrier refused the frame: ${decoded.left.message}`);
    }
    return decoded.right!;
}

/** The WS client's ordered room send named `name` on the track `stream`, at least once. */
export function createOrderedRoomBroadcast(name: string, ack: ALAckMode): ALMessage {
    return newALBroadcastMessage(
        SESSION_ID,
        newALRoute('room.stream', ORIGIN_ROOM.groupId, name),
        'room',
        'stream.message.v1',
        { name },
        { groupRef: ORIGIN_ROOM, ttlMs: 30_000, reliability: 'at-least-once', ack, ordering: { orderingKey: 'stream' } }
    );
}

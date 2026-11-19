import { expect, onTestFinished, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    reconstructALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import '../../setup-browser-indexeddb.ts';
import { ORIGIN_ROOM } from '../multicast/rtc-origin-overlay-fixture.ts';
import { readInboundTestWorkDueAtMs } from '../wait-for-al-inbound-work.ts';
import {
    createInboundTestRuntime,
    createInboundTestStores,
    runInboundWorkDueNow,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import {
    createOutboundTestRuntimeFor,
    createWsClientCarrierStores,
    createWsClientMintingPlanner,
    drainOutboundWorkDueNow,
    peekOutboundWorkReadyAt,
    type WsClientCarrierStoreKind,
    type WsClientCarrierStores
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
}

/**
 * A WS client's sender and a receiver standing for its server, wired through a link that loses what `drop` names. Every
 * control the receiver sends reaches the sender; one fake clock drives both.
 */
export function createLossyLink(store: WsClientCarrierStoreKind, input: LossyLinkInput): LossyLink {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LINK_START_MS);
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const frames: LossyLinkFrame[] = [];
    const inFlight: ALMessage[] = [];
    const senderStores = createWsClientCarrierStores(SESSION_ID, store);
    const sender = createLinkSender(senderStores, (message) => {
        const seq = message.ordering?.seq;
        const frame = { seq, copy: frames.filter((written) => written.seq === seq).length + 1, message };
        frames.push(frame);
        if (!input.drop(frame)) {
            inFlight.push(message);
        }
    });
    const receiver = createLinkReceiver(store);
    let forwardedControls = 0;
    const exchange = async (): Promise<void> => {
        for (let round = 0; round < LINK_EXCHANGE_LIMIT; round += 1) {
            for (const frame of inFlight.splice(0)) {
                await receiver.runtime.admitIncomingMessage(frame, WS_CLIENT_SOURCE);
            }
            await runInboundWorkDueNow(receiver);
            const controls = receiver.controlSends.flat().slice(forwardedControls);
            forwardedControls += controls.length;
            for (const control of controls) {
                await sender.acceptControlMessage(control, 'peer');
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
            await peekOutboundWorkReadyAt(senderStores.workQueue, senderStores.admissionStore.namespace)
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
        }
    };
}

/** The WS client's sender as `WsQueueBoxClientService` composes it: its own planner, the server as its one hop. */
function createLinkSender(
    stores: WsClientCarrierStores,
    write: (message: ALMessage) => void
): ALOutboundMessageRuntime<ALOutboundTransportMessage> {
    return createOutboundTestRuntimeFor({
        stores,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: createWsClientMintingPlanner(SESSION_ID),
        planRepairMessage: undefined,
        hopPeerIds: [SERVER_PEER_ID],
        sendPreparedMessage: async (prepared, _phase, lifecycle) => {
            write(reconstructALOutboundTransportMessage(prepared, lifecycle.canonicalMessage));
            return { status: 'sent', submissionAttempted: true };
        }
    });
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

function createOrderedRoomBroadcast(name: string, ack: ALAckMode): ALMessage {
    return newALBroadcastMessage(
        SESSION_ID,
        newALRoute('room.stream', ORIGIN_ROOM.groupId, name),
        'room',
        'stream.message.v1',
        { name },
        { groupRef: ORIGIN_ROOM, ttlMs: 30_000, reliability: 'at-least-once', ack, ordering: { orderingKey: 'stream' } }
    );
}

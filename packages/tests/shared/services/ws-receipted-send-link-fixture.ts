import { expect, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage, type ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/read-al-outbound-recipient-proof.ts';
import { toALOutboundFirstHopTimeoutEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { acceptWsQueueBoxClientControlMessage } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';
import type { WsServerInboundAuthorization } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import {
    readSentReceipts,
    toControlLabel,
    toNotYetInSyncRefusal,
    toWsDeliveredAckMessage,
    type ControlFrameLabel
} from '../../ws-receipted-send-test-controls.ts';
import {
    createWsClientCarrierStores,
    createWsClientMintingPlanner,
    createWsClientSender,
    drainEngine,
    drainOutboundWorkDueNow,
    peekOutboundWorkReadyAt,
    type WsClientCarrierStores
} from '../alm/outbound-runtime-test-fixture.ts';
import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { attachTestWebSocket } from '../websocket/attach-test-web-socket.ts';
import { createServerIngressFixture, type ServerIngressFixture } from './ws-queue-box-server-ingress-fixture.ts';

export const LINK_ORIGIN_ID = 'origin';
export const LINK_PEER_ID = 'peer-b';
export const LINK_START_MS = Date.UTC(2026, 10, 20, 12);
export const LINK_MESSAGE_TTL_MS = 30_000;
const LINK_ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
/**
 * Passes of one step: a send the server's replay admits is delivered after six passes and its `admitted` reaches the
 * sender after nine, so twelve carry a replayed send to its sender within the step that let the server admit it.
 */
const LINK_PASSES_PER_STEP = 12;

/**
 * in-sync: authorized, audience [origin, peer-b], snapshotVersion 2. behind: `not-yet-in-sync`, sendNack, serverSnapshotVersion 1.
 * fenced: `membership-fenced`, sendNack. peer-b-left: authorized, audience [origin], snapshotVersion 3.
 * peer-c-joined: authorized, audience [origin, peer-b, peer-c], snapshotVersion 4.
 */
export type WsReceiptedSendRoomView = 'in-sync' | 'behind' | 'fenced' | 'peer-b-left' | 'peer-c-joined';

/** One control the server sent the origin, `nack:<reason>` or `receipt:<phase>`, and what the origin's outbound owner decided. */
export interface WsReceiptedSendServerControl extends ControlFrameLabel {
    readonly admission: ALOutboundControlAdmissionResult['kind'];
}

/** A WS client's sender wired to the real WS server ingress and receipt aggregation, and a recipient that may ACK. */
export interface WsReceiptedSendLink {
    readonly written: readonly string[];
    readonly settlements: readonly ALDeliverySettlement[];
    readonly serverControls: readonly WsReceiptedSendServerControl[];
    setRoomView(view: WsReceiptedSendRoomView): void;
    /** The view the room authority answers with once it has answered `reads` reads of `msg`'s authority. */
    setRoomViewAfterReadsOf(msg: ALMessage, reads: number, view: WsReceiptedSendRoomView): void;
    /** Admits at the client and writes its frame, to ingress or to the hold; runs no server work. */
    send(message: ALMessage): Promise<ALMessage>;
    holdFrames(): void;
    /** Hands every held frame to ingress at once, as frames of the origin's one socket, and ends the hold; the acceptance of each, in send order. */
    writeHeldFramesSideBySide(): Promise<readonly string[]>;
    /** Hands one more copy of a written frame to ingress; its acceptance kind, or `rejected`. */
    writeCopy(msg: ALMessage): Promise<string>;
    /** The recipient's `delivered` ACK through the server's ingress, as its socket would send it. */
    acknowledge(msg: ALMessage): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>>;
    /** Moves the one clock, then `LINK_PASSES_PER_STEP` times: the server's engine, its answers to the client, the client's due work. */
    advance(ms: number): Promise<void>;
    deliveredToPeer(msg: ALMessage): number;
    readReceiptsToOrigin(msg: ALMessage): readonly ALReceiptPayload[];
    readSenderRows(msg: ALMessage): Promise<{ readonly waits: boolean; readonly ended: boolean | undefined; }>;
    readFirstHopTimeoutStatus(msg: ALMessage): Promise<string | undefined>;
    readWorkReadyAt(): Promise<number | undefined>;
}

export async function createWsReceiptedSendLink(startView: WsReceiptedSendRoomView): Promise<WsReceiptedSendLink> {
    let view = startView;
    const reads = new Map<string, number>();
    let next: { readonly msgId: string; readonly reads: number; readonly view: WsReceiptedSendRoomView; } | undefined;
    const server = await createServerIngressFixture(undefined, LINK_ORIGIN_ID);
    const peer = new SimulatedWebSocket('ws://peer');
    await peer.open();
    attachTestWebSocket(server.server, new ConnectionContext({ id: LINK_PEER_ID, socket: peer }));
    server.service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) => {
            const authorization = toRoomViewAuthorization(view);
            const read = (reads.get(message.id.msgId) ?? 0) + 1;
            reads.set(message.id.msgId, read);
            if (next?.msgId === message.id.msgId && next.reads === read) {
                view = next.view;
            }
            return authorization;
        }
    });

    const client = createLinkClient(server);
    const exchange = createLinkExchange(server, client);
    return {
        written: client.written,
        settlements: client.settlements,
        serverControls: exchange.serverControls,
        setRoomView: (nextView) => {
            view = nextView;
        },
        setRoomViewAfterReadsOf: (msg, afterReads, nextView) => {
            next = { msgId: msg.id.msgId, reads: afterReads, view: nextView };
        },
        send: client.send,
        holdFrames: client.holdFrames,
        writeHeldFramesSideBySide: client.writeHeldFramesSideBySide,
        writeCopy: client.writeCopy,
        acknowledge: async (msg) => await server.service.acceptIncomingMessage(toWireCopy(toPeerAck(msg)), LINK_PEER_ID),
        advance: async (ms) => {
            vi.setSystemTime(Date.now() + ms);
            await exchange.run();
        },
        deliveredToPeer: (msg) => toFrames(peer).filter((frame) => frame.id.msgId === msg.id.msgId).length,
        readReceiptsToOrigin: (msg) => readSentReceipts(server.socket).filter((receipt) => receipt.msgId === msg.id.msgId),
        ...createLinkSenderReads(client.stores)
    };
}

interface LinkClient {
    readonly stores: WsClientCarrierStores;
    readonly ws: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    readonly written: string[];
    readonly settlements: ALDeliverySettlement[];
    send(message: ALMessage): Promise<ALMessage>;
    holdFrames(): void;
    writeHeldFramesSideBySide(): Promise<readonly string[]>;
    writeCopy(msg: ALMessage): Promise<string>;
}

function createLinkClient(server: ServerIngressFixture): LinkClient {
    const written: string[] = [];
    const frames: ALMessage[] = [];
    const settlements: ALDeliverySettlement[] = [];
    const held: ALMessage[] = [];
    let holding = false;
    const writeToIngress = async (frame: ALMessage): Promise<string> =>
        toAcceptanceKind(await server.service.acceptIncomingMessage(toWireCopy(frame), LINK_ORIGIN_ID));
    const stores = createWsClientCarrierStores(LINK_ORIGIN_ID, 'memory');
    const ws = createWsClientSender({
        stores,
        settlements: (fact) => settlements.push(fact),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            written.push(lifecycle.canonicalMessage.id.msgId);
            frames.push(lifecycle.canonicalMessage);
            if (holding) {
                held.push(lifecycle.canonicalMessage);
            }
            else {
                await writeToIngress(lifecycle.canonicalMessage);
            }
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return {
        stores,
        ws,
        written,
        settlements,
        send: async (message) => {
            const result = await ws.enqueueIfAbsent(message);
            expect(result.verdict.kind, result.reason).toBe('admitted');
            await drainOutboundWorkDueNow(ws, stores);
            return result.message;
        },
        holdFrames: () => {
            holding = true;
        },
        writeHeldFramesSideBySide: async () => {
            holding = false;
            return await Promise.all(held.splice(0).map(writeToIngress));
        },
        writeCopy: async (msg) => {
            const frame = frames.find((candidate) => candidate.id.msgId === msg.id.msgId);
            expect(frame, `no frame of ${msg.id.msgId} was written`).toBeDefined();
            return await writeToIngress(frame!);
        }
    };
}

function createLinkExchange(
    server: ServerIngressFixture,
    client: LinkClient
): { readonly serverControls: readonly WsReceiptedSendServerControl[]; run(): Promise<void>; } {
    const serverControls: WsReceiptedSendServerControl[] = [];
    let relayed = 0;
    const run = async (): Promise<void> => {
        for (let pass = 0; pass < LINK_PASSES_PER_STEP; pass += 1) {
            await drainEngine(server.engine);
            for (; relayed < server.socket.sent.length; relayed += 1) {
                const answer = decodePersistedALMessage(String(server.socket.sent[relayed]));
                const admission = (await acceptWsQueueBoxClientControlMessage(client.ws, answer)).kind;
                serverControls.push({ ...toControlLabel(answer), admission });
            }
            await drainOutboundWorkDueNow(client.ws, client.stores);
        }
    };
    return { serverControls, run };
}

function createLinkSenderReads(
    stores: WsClientCarrierStores
): Pick<WsReceiptedSendLink, 'readSenderRows' | 'readFirstHopTimeoutStatus' | 'readWorkReadyAt'> {
    return {
        readSenderRows: async (msg) => {
            const read = await stores.admissionStore.readRepairMessage(msg.id.msgId, createWsClientMintingPlanner(LINK_ORIGIN_ID));
            return { waits: read.firstHopWait !== undefined, ended: read.storedMessage?.ended };
        },
        readFirstHopTimeoutStatus: async (msg) =>
            (await stores.admissionStore.readWork(toALOutboundWorkKey(
                stores.admissionStore.namespace,
                toALOutboundFirstHopTimeoutEffectId({ msgId: msg.id.msgId, attempts: 0, deadlineAtMs: LINK_START_MS + 2_000 })
            )))?.status,
        readWorkReadyAt: async () => await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)
    };
}

function toRoomViewAuthorization(view: WsReceiptedSendRoomView): WsServerInboundAuthorization {
    if (view === 'behind') {
        return toNotYetInSyncRefusal(1);
    }
    if (view === 'fenced') {
        return { authorized: false, reason: 'membership-fenced', logMessage: 'Sender left the room', sendNack: true };
    }
    if (view === 'peer-b-left') {
        return { authorized: true, roomAudience: { recipientPeerIds: [LINK_ORIGIN_ID], snapshotVersion: 3 } };
    }
    if (view === 'peer-c-joined') {
        return { authorized: true, roomAudience: { recipientPeerIds: [LINK_ORIGIN_ID, LINK_PEER_ID, 'peer-c'], snapshotVersion: 4 } };
    }
    return { authorized: true, roomAudience: { recipientPeerIds: [LINK_ORIGIN_ID, LINK_PEER_ID], snapshotVersion: 2 } };
}

function toPeerAck(msg: ALMessage): ALMessage {
    return toWsDeliveredAckMessage({
        ackedMsgId: msg.id.msgId,
        fromPeerId: LINK_PEER_ID,
        originPeerId: LINK_ORIGIN_ID,
        traceId: msg.id.traceId
    });
}

function toAcceptanceKind(accepted: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>): string {
    return accepted.right?.kind ?? 'rejected';
}

function toFrames(socket: SimulatedWebSocket): readonly ALMessage[] {
    return socket.sent.map((frame) => decodePersistedALMessage(String(frame)));
}

/** The frame as the server's socket would decode it: a JSON copy, never the client's own object. */
function toWireCopy(message: ALMessage): ALMessage {
    return decodePersistedALMessage(JSON.stringify(message));
}

/** D694's room notice: a receiver-receipted, at-least-once room broadcast that lives 30 s. */
export function toRoomNotice(): ALMessage {
    return toLinkRoomNotice(undefined);
}

export function toOrderedRoomNotice(): ALMessage {
    return toLinkRoomNotice({ orderingKey: 'track-1' });
}

function toLinkRoomNotice(ordering: { readonly orderingKey: string; } | undefined): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: LINK_ORIGIN_ID,
        route: newALRoute('room.notification', LINK_ROOM.groupId, 'only'),
        scope: 'room',
        typeId: 'notice.v1',
        resource: { text: 'hello' },
        options: {
            groupRef: LINK_ROOM,
            ttlMs: LINK_MESSAGE_TTL_MS,
            reliability: 'at-least-once',
            ack: 'receiver',
            ...(ordering === undefined ? {} : { ordering })
        }
    });
}

/** A receiver-receipted unicast that names the room, so the server answers it as a room send. */
export function toRoomUnicast(toPeerId: string): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: LINK_ORIGIN_ID,
        route: newALRoute('room.command', LINK_ROOM.groupId, `to-${toPeerId}`),
        toPeerId,
        typeId: 'command.v1',
        resource: {},
        options: { groupRef: LINK_ROOM, ttlMs: LINK_MESSAGE_TTL_MS, reliability: 'at-least-once', ack: 'receiver' }
    });
}

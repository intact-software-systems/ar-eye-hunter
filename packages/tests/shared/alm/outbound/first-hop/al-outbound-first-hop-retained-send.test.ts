import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { toALOutboundFirstHopTimeoutEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { acceptWsQueueBoxClientControlMessage } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../../../native-websocket-fixture.ts';
import { createServerIngressFixture } from '../../../services/ws-queue-box-server-ingress-fixture.ts';
import { attachTestWebSocket } from '../../../websocket/attach-test-web-socket.ts';
import {
    createWsClientCarrierStores,
    createWsClientMintingPlanner,
    createWsClientSender,
    drainEngine,
    drainOutboundWorkDueNow,
    peekOutboundWorkReadyAt
} from '../../outbound-runtime-test-fixture.ts';

const SESSION_ID = 'origin';
const PEER_ID = 'peer-b';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const START_MS = Date.UTC(2026, 10, 20, 12);
const MESSAGE_TTL_MS = 30_000;
/** How many engine passes one step gives the server, so a retained send it can now admit replays and is delivered. */
const SERVER_PASSES = 4;

/** A WS client's sender wired to the real WS server ingress and receipt aggregation, whose room view may lag. */
interface RetainedSendLink {
    /** Every frame the client wrote to its socket, by message id. */
    readonly written: readonly string[];
    readonly settlements: readonly ALDeliverySettlement[];
    /** What the client's outbound owner decided about each control the server sent it. */
    readonly controlAdmissions: readonly ALOutboundControlAdmissionResult['kind'][];
    /** The server's room view: behind, it answers a room send `not-yet-in-sync` and retains it. */
    setServerBehind(behind: boolean): void;
    send(): Promise<ALMessage>;
    /** Moves the one clock, runs the server's engine, carries its answers to the client and runs the client's work. */
    advance(ms: number): Promise<void>;
    /** How many frames of the message reached the other member of the room. */
    deliveredToPeer(msg: ALMessage): number;
    receiptPhasesToClient(): readonly string[];
    readFirstHopTimeoutStatus(msg: ALMessage): Promise<string | undefined>;
    readWorkReadyAt(): Promise<number | undefined>;
    readSenderRows(msg: ALMessage): Promise<{ readonly waits: boolean; readonly ended: boolean | undefined; }>;
}

describe('a WS client\'s receipted room send the server retains behind its room view', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('a server in step answers admitted, and the one frame is delivered', async () => {
        const link = await createRetainedSendLink(false);
        const sent = await link.send();
        await advanceThroughDeadline(link);

        expect(link.receiptPhasesToClient()).toContain('admitted');
        expect(link.written).toEqual([sent.id.msgId]);
        expect(link.deliveredToPeer(sent)).toBe(1);
        expect(toTerminalKinds(link)).toEqual([]);
    });

    it.each([1_000, 9_000])(
        'a server behind for %i ms ends the first-hop wait with its not-yet-in-sync answer: one frame, nothing stated, delivered once it catches up',
        async (behindMs) => {
            const link = await createRetainedSendLink(true);
            const sent = await link.send();

            expect(link.controlAdmissions).toEqual(['committed']);
            expect(await link.readSenderRows(sent)).toEqual({ waits: false, ended: false });
            expect(await link.readFirstHopTimeoutStatus(sent)).toBe(EntityStatus.COMPLETED);
            expect(await link.readWorkReadyAt()).toBeUndefined();

            for (let elapsedMs = 0; elapsedMs < behindMs; elapsedMs += 1_000) {
                await link.advance(1_000);
            }
            expect(link.deliveredToPeer(sent)).toBe(0);
            link.setServerBehind(false);
            await link.advance(200);
            expect(link.deliveredToPeer(sent)).toBe(1);

            await advanceThroughDeadline(link);
            expect(link.written).toEqual([sent.id.msgId]);
            expect(link.deliveredToPeer(sent)).toBe(1);
            expect(toTerminalKinds(link)).toEqual([]);
            expect((await link.readSenderRows(sent)).ended).toBe(false);
        }
    );
});

/** Steps of one second to past the message's deadline: every first-hop deadline the send could have is reached. */
async function advanceThroughDeadline(link: RetainedSendLink): Promise<void> {
    for (let step = 0; step <= MESSAGE_TTL_MS / 1_000; step += 1) {
        await link.advance(1_000);
    }
}

/** The kinds of the facts stated that would end the message: a terminal receipt, a relay's refusal, a refused re-plan. */
function toTerminalKinds(link: RetainedSendLink): readonly string[] {
    return link.settlements.flatMap((fact) =>
        fact.kind === 'receipt-exhausted' || fact.kind === 'relay-rejected' ||
            (fact.kind === 'admission' && fact.verdict.kind === 'refused') ||
            (fact.kind === 'acknowledgement' && fact.complete)
            ? [fact.kind]
            : []
    );
}

async function createRetainedSendLink(startsBehind: boolean): Promise<RetainedSendLink> {
    let behind = startsBehind;
    const server = await createServerIngressFixture(undefined, SESSION_ID);
    const peer = new SimulatedWebSocket('ws://peer');
    await peer.open();
    attachTestWebSocket(server.server, new ConnectionContext({ id: PEER_ID, socket: peer }));
    server.service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async () =>
            behind
                ? {
                    authorized: false,
                    reason: 'not-yet-in-sync',
                    logMessage: 'Room snapshot is catching up',
                    sendNack: true,
                    serverSnapshotVersion: 1
                }
                : { authorized: true, roomAudience: { recipientPeerIds: [SESSION_ID, PEER_ID], snapshotVersion: 2 } }
    });

    const written: string[] = [];
    const settlements: ALDeliverySettlement[] = [];
    const controlAdmissions: ALOutboundControlAdmissionResult['kind'][] = [];
    const stores = createWsClientCarrierStores(SESSION_ID, 'memory');
    const ws = createWsClientSender({
        stores,
        settlements: (fact) => settlements.push(fact),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            written.push(lifecycle.canonicalMessage.id.msgId);
            await server.service.acceptIncomingMessage(JSON.parse(JSON.stringify(lifecycle.canonicalMessage)), SESSION_ID);
            return { status: 'sent', submissionAttempted: true };
        }
    });

    let relayed = 0;
    const exchange = async (): Promise<void> => {
        for (let pass = 0; pass < SERVER_PASSES; pass += 1) {
            await drainEngine(server.engine);
            for (; relayed < server.socket.sent.length; relayed += 1) {
                const answer = decodePersistedALMessage(String(server.socket.sent[relayed]));
                controlAdmissions.push((await acceptWsQueueBoxClientControlMessage(ws, answer)).kind);
            }
            await drainOutboundWorkDueNow(ws, stores);
        }
    };
    const framesTo = (socket: SimulatedWebSocket) => socket.sent.map((frame) => decodePersistedALMessage(String(frame)));

    return {
        written,
        settlements,
        controlAdmissions,
        setServerBehind: (next) => {
            behind = next;
        },
        send: async () => {
            const result = await ws.enqueueIfAbsent(toRoomNotice());
            expect(result.verdict.kind, result.reason).toBe('admitted');
            await drainOutboundWorkDueNow(ws, stores);
            await exchange();
            return result.message;
        },
        advance: async (ms) => {
            vi.setSystemTime(Date.now() + ms);
            await exchange();
        },
        deliveredToPeer: (msg) => framesTo(peer).filter((frame) => frame.id.msgId === msg.id.msgId).length,
        receiptPhasesToClient: () =>
            framesTo(server.socket)
                .filter((frame) => frame.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
                .map((frame) => decodeALReceiptPayload(JSON.parse(frame.payload.resource)).phase),
        readFirstHopTimeoutStatus: async (msg) =>
            (await stores.admissionStore.readWork(toALOutboundWorkKey(
                stores.admissionStore.namespace,
                toALOutboundFirstHopTimeoutEffectId({ msgId: msg.id.msgId, attempts: 0, deadlineAtMs: START_MS + 2_000 })
            )))?.status,
        readWorkReadyAt: async () => await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace),
        readSenderRows: async (msg) => {
            const read = await stores.admissionStore.readRepairMessage(msg.id.msgId, createWsClientMintingPlanner(SESSION_ID));
            return { waits: read.firstHopWait !== undefined, ended: read.storedMessage?.ended };
        }
    };
}

function toRoomNotice(): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: SESSION_ID,
        route: newALRoute('room.notification', ROOM.groupId, 'only'),
        scope: 'room',
        typeId: 'notice.v1',
        resource: { text: 'hello' },
        options: { groupRef: ROOM, ttlMs: MESSAGE_TTL_MS, reliability: 'at-least-once', ack: 'receiver' }
    });
}

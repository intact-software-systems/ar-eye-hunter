import { Temporal } from '@js-temporal/polyfill';
import {
    expect,
    onTestFinished,
    vi
} from 'vitest';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService, WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { captureOutboundWorkRunnable } from '../alm/outbound-runtime-test-fixture.ts';
import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

export interface ReceiptClock {
    nowMs: number;
}

export interface ClusterInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly server: JsonWebSocketServer;
}

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const SNAPSHOT_VERSION = 7;
const ROOM_MESSAGE_LIFETIME_MS = 30_000;

interface ReceiptWorkClaim {
    readonly worker: string;
    readonly msgId: string | undefined;
    readonly payloadType: string | undefined;
    readonly action: string;
    readonly prepared?: WsQueueBoxServerPreparedMessage;
}

interface ReceiptWorkerHandoffInput {
    readonly storesA: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly storesB: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly nowMs: number;
}

interface ReceiptWorkSchedule extends ReceiptWorkerHandoffInput {
    readonly claims: ReceiptWorkClaim[];
    readonly readWorker: () => 'A' | 'B';
}

interface ReceiptWorkerHandoffResult {
    readonly receipts: readonly ALReceiptPayload[];
    readonly wrongFrames: readonly string[];
    readonly claims: readonly ReceiptWorkClaim[];
}

interface CreateClusterInstanceInput {
    readonly name: string;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly bus: QueueBoxPubSubBridge;
    readonly publisherId: string;
    readonly engine: InboxOutboxEngine;
}

export function installClock(): ReceiptClock {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    return clock;
}

/** One server instance of the cluster, fanning room messages out through its own outbox as production does. */
export async function createClusterInstance(input: CreateClusterInstanceInput): Promise<ClusterInstance> {
    const server = new JsonWebSocketServer();
    const engine = input.engine;
    const openRecipients = () =>
        [...server.connections.values()].filter((connection) => connection.isOpen).map((connection) => ({
            peerId: connection.id,
            connectionId: connection.id
        }));
    const service = createDefaultWsQueueBoxServerService({
        outbox: input.outboundStores.workQueue,
        outboundStores: input.outboundStores,
        socket: server,
        readAuthenticatedConnectionScope: (connection) =>
            server.connections.get(connection.id) === connection
                ? { scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        name: input.name,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        targetResolver: {
            resolvePeerRecipients: (peerId) => openRecipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: () => openRecipients().filter((recipient) => ['a', 'b', 'c'].includes(recipient.peerId))
        }
    });
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? { authorized: true, roomAudience: { recipientPeerIds: ['a', 'b', 'c'], snapshotVersion: SNAPSHOT_VERSION } }
                : { authorized: true }
    });
    service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            await service.enqueueOutboxIfAbsent(message);
        }
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
    });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: service, bridge: input.bus, channel: 'ws', publisherId: input.publisherId });
    return { service, engine, server };
}

export async function connect(instance: ClusterInstance, peerId: string): Promise<SimulatedWebSocket> {
    const socket = new SimulatedWebSocket(`ws://${peerId}-on-${instance.service.name}`);
    await socket.open();
    instance.server.addConnection(new ConnectionContext({ id: peerId, socket }));
    return socket;
}

export function createBridgeBus(): QueueBoxPubSubBridge {
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    return {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
        }
    };
}

export function roomMessage(nowMs: number): ALMessage {
    return {
        id: { v: 3, msgId: 'room-message-1', ts: nowMs, senderId: 'a' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + ROOM_MESSAGE_LIFETIME_MS },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

export function readSentReceipts(socket: SimulatedWebSocket): readonly ALReceiptPayload[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}

/** Runs A's real dequeue task, then B's real send task; neither engine starts a timer loop. */
export async function runReceiptWorkerHandoff(input: ReceiptWorkerHandoffInput): Promise<ReceiptWorkerHandoffResult> {
    const bus = createBridgeBus();
    const engineA = new InboxOutboxEngine();
    const engineB = new InboxOutboxEngine();
    const runA = captureOutboundWorkRunnable(engineA);
    const runB = captureOutboundWorkRunnable(engineB);
    const local = await createClusterInstance({ name: 'server', outboundStores: input.storesA, bus, publisherId: 'local', engine: engineA });
    const remote = await createClusterInstance({ name: 'remote-server', outboundStores: input.storesB, bus, publisherId: 'remote', engine: engineB });
    const alice = await connect(local, 'a');
    const wrong = await connect(remote, 'wrong');
    const claims: ReceiptWorkClaim[] = [];
    let worker: 'A' | 'B' = 'A';
    holdReceiptWorkForWorker({ ...input, claims, readWorker: () => worker });
    expect((await local.service.acceptIncomingMessage(roomMessage(input.nowMs), 'a')).right?.kind).toBe('admitted');
    // Admission may have started A already; settle that batch and its commit-triggered follow-up.
    await runA();
    await runA();
    expect(claims.filter((claim) => claim.worker === 'A' && claim.payloadType === AL_CONTROL_RECEIPT_TYPE_ID)).toHaveLength(1);
    expect(readSentReceipts(alice)).toEqual([]);
    worker = 'B';
    await runB();
    const receiptDequeue = claims.find((claim) => claim.worker === 'A' && claim.payloadType === AL_CONTROL_RECEIPT_TYPE_ID)!;
    expect(claims.filter((claim) => claim.worker === 'B' && claim.msgId === receiptDequeue.msgId).map((claim) => claim.action)).toEqual(['send-prepared']);
    return { receipts: readSentReceipts(alice), wrongFrames: wrong.sent, claims };
}

/** Restricts only public claims; the real stores still read, commit and release every selected row. */
function holdReceiptWorkForWorker(input: ReceiptWorkSchedule): void {
    for (const workQueue of new Set([input.storesA.workQueue, input.storesB.workQueue])) {
        const reserve = workQueue.reserveEntries.bind(workQueue);
        vi.spyOn(workQueue, 'reserveEntries').mockImplementation(async (request) => {
            const worker = input.readWorker();
            const typeIds = new Set(
                [...request.typeIds].filter((typeId) =>
                    worker === 'A' ? typeId === WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE : typeId !== WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE
                )
            );
            const reserved = await reserve({ ...request, typeIds });
            for (const entry of reserved.values()) {
                if (worker === 'A') {
                    const message = decodePersistedALMessage(entry.resource);
                    input.claims.push({ worker, msgId: message.id.msgId, payloadType: message.payload.typeId, action: 'dequeue' });
                }
                else {
                    const snapshot = await input.storesB.admissionStore.readWorkSnapshot(entry, undefined);
                    input.claims.push({
                        worker,
                        msgId: snapshot.canonicalMessage?.id.msgId,
                        payloadType: snapshot.canonicalMessage?.payload.typeId,
                        action: snapshot.payload.kind,
                        prepared: snapshot.payload.kind === 'send-prepared' ? snapshot.payload.prepared : undefined
                    });
                }
            }
            return reserved;
        });
    }
}

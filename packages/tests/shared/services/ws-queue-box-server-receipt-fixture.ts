import { Temporal } from '@js-temporal/polyfill';
import {
    expect,
    onTestFinished,
    vi
} from 'vitest';

import type { RallarAlmReceiptDiagnosticsRecorder } from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend, type ALAdmissionMemoryState } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { createDefaultInMemoryALInboundRuntimeStores, createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundRuntimeStores, ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALReceiptRecordNamespace } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import type { ALReceiptRecordStores } from '@shared/alm/receipt-record/al-receipt-record-stores.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type {
    WsCapturedRecipientEligibilityFilters,
    WsServerInboundAuthorization
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import type {
    WsQueueBoxServerReceiptObservation,
    WsQueueBoxServerReceiptObserver,
    WsQueueBoxServerReceiptOutboxVerdict
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { createDefaultWsQueueBoxServerService, WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { captureOutboundWorkRunnable } from '../alm/outbound-runtime-test-fixture.ts';
import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

import { toTestALAckPayload } from '../../al-control-test-payloads.ts';
import { readSentReceipts } from '../../ws-receipted-send-test-controls.ts';
import { attachTestWebSocket } from '../websocket/attach-test-web-socket.ts';

export interface ReceiptClock {
    nowMs: number;
}

export interface ClusterInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly server: JsonWebSocketServer;
}

/** One WS server whose sockets are opened up front, so a test reads exactly what each session was sent. */
export interface ReceiptServerInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<string, SimulatedWebSocket>>;
}

/** Two instances that share the outbox and the outbound admission state share them as PostgreSQL does. */
export interface CreateReceiptServerInput {
    readonly outbox: InMemoryQueueBox;
    readonly state: ALAdmissionMemoryState;
    readonly peerIds: readonly string[];
    readonly recorder: RallarAlmReceiptDiagnosticsRecorder | undefined;
    readonly nowMs: () => number;
    readonly inboundStores: ALInboundRuntimeStores;
    readonly inboundVolatileStores: ALVolatileInboundRuntimeStores | undefined;
    readonly receiptRecordStores: ALReceiptRecordStores;
    /** The backend the outbound owner writes through; undefined, a memory backend over `state`. */
    readonly outboundBackend: ALAdmissionWorkBackend | undefined;
    /** Durable presence and its siblings; undefined, no filter, so every captured session stays eligible. */
    readonly capturedRecipientEligibilityFilters: WsCapturedRecipientEligibilityFilters | undefined;
    readonly receiptObserver: WsQueueBoxServerReceiptObserver | undefined;
}

/** The inbound admission and receipt record state every instance of one test shares, as instances share PostgreSQL. */
export interface ReceiptClusterState {
    readonly inbound: ALAdmissionMemoryState;
    readonly record: ALAdmissionMemoryState;
}

/** One instance's own store objects over its cluster's shared state. */
export interface ReceiptInstanceStores {
    readonly inboundStores: ALInboundRuntimeStores;
    readonly receiptRecordStores: ALReceiptRecordStores;
}

/** Whether the room authority's view is current: a room message is kept for admission while it is not. */
export interface ReceiptRoomView {
    inSync: boolean;
}

/** Message identity and clock of one room message, named by each caller. */
export interface RoomMessageInput {
    readonly msgId: string;
    readonly originPeerId: string;
    readonly nowMs: number;
    readonly lifetimeMs: number;
}

/** The ACK `recipient` sends for the room message `msgId` of `originPeerId`. */
export interface ReceiverAckInput {
    readonly msgId: string;
    readonly originPeerId: string;
    readonly recipient: string;
    readonly nowMs: number;
}

/** One receipt control a socket was sent: its control id and its receipt. */
export interface SentReceipt {
    readonly controlId: string;
    readonly receipt: ALReceiptPayload;
}

/** One refusal, count or receipt the receipt aggregation recorded: `kind`, then the count's outcome or the receipt's phase and outbox verdict. */
export type ReceiptAggregationVerdict =
    | 'ack-rejection'
    | `ack-count:${Extract<WsQueueBoxServerReceiptObservation, { readonly kind: 'ack-count'; }>['outcome']}`
    | `receipt-outbox:${ALReceiptPayload['phase']}:${WsQueueBoxServerReceiptOutboxVerdict['kind']}`;

/** The peer id of the server the receipt suites build; a session's ACK names it. */
export const RECEIPT_SERVER_PEER_ID = 'server';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const SCOPE = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId };
const SESSION_SCOPE_LIFETIME_MS = 60_000;
const SNAPSHOT_VERSION = 7;
const RECEIPT_CLUSTER_NAMESPACE = 'server-ws-qbox:receipt-cluster';

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
    readonly inboundStores: ALInboundRuntimeStores;
    readonly inboundVolatileStores: ALVolatileInboundRuntimeStores | undefined;
    readonly receiptRecordStores: ALReceiptRecordStores;
    readonly receiptObserver: WsQueueBoxServerReceiptObserver | undefined;
    readonly roomView: ReceiptRoomView;
    readonly bus: QueueBoxPubSubBridge;
    readonly publisherId: string;
    readonly engine: InboxOutboxEngine;
    /** The room's sessions: a room message is authorized to and broadcast among exactly these. */
    readonly roomPeerIds: readonly string[];
}

/** A clock the test advances by hand; the test's end restores the real one. */
export function installClock(): ReceiptClock {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    onTestFinished(() => {
        vi.restoreAllMocks();
    });
    return clock;
}

export function createReceiptOutbox(clock: ReceiptClock): InMemoryQueueBox {
    return new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
}

export function createReceiptClusterState(nowMs: () => number): ReceiptClusterState {
    const toInstant = () => Temporal.Instant.fromEpochMilliseconds(nowMs());
    return {
        inbound: createInMemoryALAdmissionState(new InMemoryQueueBox(new Map(), toInstant)),
        record: createInMemoryALAdmissionState(new InMemoryQueueBox(new Map(), toInstant))
    };
}

export function createReceiptInstanceStores(state: ReceiptClusterState, nowMs: () => number): ReceiptInstanceStores {
    return {
        inboundStores: createDefaultInMemoryALInboundRuntimeStores({
            nowMs,
            namespace: RECEIPT_CLUSTER_NAMESPACE,
            inboundBackend: new InMemoryAdmissionBackend(state.inbound, nowMs)
        }),
        receiptRecordStores: {
            backend: new InMemoryAdmissionBackend(state.record, nowMs),
            namespace: toALReceiptRecordNamespace(RECEIPT_CLUSTER_NAMESPACE)
        }
    };
}

export async function createReceiptServer(input: CreateReceiptServerInput): Promise<ReceiptServerInstance> {
    const socketServer = new JsonWebSocketServer();
    const sockets: Record<string, SimulatedWebSocket> = {};
    for (const peerId of input.peerIds) {
        const socket = new SimulatedWebSocket(`ws://${peerId}`);
        await socket.open();
        attachTestWebSocket(socketServer, new ConnectionContext({ id: peerId, socket }));
        sockets[peerId] = socket;
    }
    const recipients = () => [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        inboundStores: input.inboundStores,
        inboundVolatileStores: input.inboundVolatileStores,
        receiptRecordStores: input.receiptRecordStores,
        outbox: input.outbox,
        socket: socketServer,
        name: RECEIPT_SERVER_PEER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            socketServer.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: input.nowMs() + SESSION_SCOPE_LIFETIME_MS }
                : undefined,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs: input.nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: input.outboundBackend ?? new InMemoryAdmissionBackend(input.state, input.nowMs)
        }),
        capturedRecipientEligibilityFilters: input.capturedRecipientEligibilityFilters,
        receiptObserver: input.receiptObserver,
        outboundSettlements: input.recorder?.settlements,
        targetResolver: {
            requiresFrozenAudience: () => false,
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets };
}

/** Runs the engine past every receipt row it could still send, so a test may assert one never comes. */
export async function settleQueueEngine(engine: InboxOutboxEngine): Promise<void> {
    for (let pass = 0; pass < 4; pass += 1) {
        await engine.executeOnce();
    }
}

export function countCopies(socket: SimulatedWebSocket, msgId: string): number {
    return socket.sent.filter((frame) => decodePersistedALMessage(frame).id.msgId === msgId).length;
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
        inboundStores: input.inboundStores,
        inboundVolatileStores: input.inboundVolatileStores,
        receiptRecordStores: input.receiptRecordStores,
        receiptObserver: input.receiptObserver,
        outbox: input.outboundStores.workQueue,
        outboundStores: input.outboundStores,
        socket: server,
        readAuthenticatedConnectionScope: (connection) =>
            server.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        name: input.name,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        targetResolver: {
            requiresFrozenAudience: () => false,
            resolvePeerRecipients: (peerId) => openRecipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: () => openRecipients().filter((recipient) => input.roomPeerIds.includes(recipient.peerId))
        }
    });
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) => toClusterRoomAuthorization(message, input)
    });
    service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            await service.enqueueOutboxIfAbsent(message);
        }
    });
    onTestFinished(async () => {
        const cleanup = await Promise.allSettled([service.dispose(), engine.stop()]);
        const failure = cleanup.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: service, bridge: input.bus, channel: 'ws', publisherId: input.publisherId });
    return { service, engine, server };
}

function toClusterRoomAuthorization(message: ALMessage, input: CreateClusterInstanceInput): WsServerInboundAuthorization {
    if (!isRoomScopedALMessage(message)) {
        return { authorized: true };
    }
    return input.roomView.inSync
        ? { authorized: true, roomAudience: { recipientPeerIds: [...input.roomPeerIds], snapshotVersion: SNAPSHOT_VERSION } }
        : {
            authorized: false,
            reason: 'not-yet-in-sync',
            logMessage: 'The room view is behind the message',
            sendNack: true,
            serverSnapshotVersion: SNAPSHOT_VERSION - 1
        };
}

export async function connect(instance: ClusterInstance, peerId: string): Promise<SimulatedWebSocket> {
    const socket = new SimulatedWebSocket(`ws://${peerId}-on-${instance.service.name}`);
    await socket.open();
    attachTestWebSocket(instance.server, new ConnectionContext({ id: peerId, socket }));
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

export function roomMessage(input: RoomMessageInput): ALMessage {
    const { msgId, originPeerId, nowMs } = input;
    return {
        id: { v: 4, msgId, ts: nowMs, senderId: originPeerId, traceId: 'trace-ws-queue-box-server-receipt-fixture' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + input.lifetimeMs },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

export function receiverAck(input: ReceiverAckInput): ALMessage {
    const { recipient, nowMs } = input;
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${recipient}-${input.msgId}`, senderId: recipient, ts: nowMs, traceId: 'trace-ws-queue-box-server-receipt-fixture' },
        toTestALAckPayload({
            ackedMsgId: input.msgId,
            fromPeerId: recipient,
            toPeerId: input.originPeerId,
            originPeerId: input.originPeerId,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: nowMs
        })
    );
}

/** Every receipt the sockets were sent for the message `msgId`, in the order each socket was sent them. */
export function readSocketReceipts(sockets: readonly SimulatedWebSocket[], msgId: string): readonly SentReceipt[] {
    return sockets.flatMap((socket) =>
        socket.sent
            .map((frame) => decodePersistedALMessage(frame))
            .filter((control) => control.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
            .map((control) => ({ controlId: control.id.msgId, receipt: decodeALReceiptPayload(JSON.parse(control.payload.resource)) }))
            .filter(({ receipt }) => receipt.msgId === msgId)
    );
}

/**
 * The origin's receipts for the message, each once whichever of its sockets carried it, in the order the server observed
 * them: a receipt row released for a retry may arrive after a later one, and an `admitted` observed at the same instant
 * as a terminal receipt precedes it.
 */
export function readOriginReceipts(originSockets: readonly SimulatedWebSocket[], msgId: string): readonly SentReceipt[] {
    const unique = new Map(readSocketReceipts(originSockets, msgId).map((sent) => [sent.controlId, sent]));
    const toOrder = ({ receipt }: SentReceipt) => [receipt.observedAtEpochMs, receipt.phase === 'admitted' ? 0 : 1] as const;
    return [...unique.values()].sort((left, right) => {
        const [leftAtMs, leftRank] = toOrder(left);
        const [rightAtMs, rightRank] = toOrder(right);
        return leftAtMs - rightAtMs || leftRank - rightRank;
    });
}

export function readOriginReceiptPhases(originSockets: readonly SimulatedWebSocket[], msgId: string): readonly ALReceiptPayload['phase'][] {
    return readOriginReceipts(originSockets, msgId).map(({ receipt }) => receipt.phase);
}

/** The origin's first terminal receipt for the message; undefined while it has read none. */
export function readOriginTerminalReceipt(originSockets: readonly SimulatedWebSocket[], msgId: string): ALReceiptPayload | undefined {
    return readOriginReceipts(originSockets, msgId).find(({ receipt }) => receipt.phase !== 'admitted')?.receipt;
}

/**
 * Each distinct terminal receipt the sockets hold for the message, read from every frame without deduplication: its
 * control id, phase and sets. "Exactly one terminal receipt" is exactly one entry, however often the outbox delivered
 * it: the outbox resends a receipt control the origin never acknowledges, under the same id. A second `end`'s receipt
 * would carry the same message-derived id, so the id alone cannot tell it apart; its phase or sets can, whatever
 * order the frames arrived in.
 */
export function readTerminalReceiptIdentities(sockets: readonly SimulatedWebSocket[], msgId: string): readonly string[] {
    const terminals = readSocketReceipts(sockets, msgId).filter(({ receipt }) => receipt.phase !== 'admitted');
    return [
        ...new Set(terminals.map(({ controlId, receipt }) => JSON.stringify({ controlId, phase: receipt.phase, ...toReceiptSets(receipt) })))
    ];
}

/**
 * Every refusal, count and receipt the receipt aggregation recorded for the message, sorted, since instances record in
 * no fixed order. An `ack-rejection` carries only its control's identity, so every one the observations hold is listed.
 */
export function readReceiptAggregationVerdicts(
    observations: readonly WsQueueBoxServerReceiptObservation[],
    msgId: string
): readonly ReceiptAggregationVerdict[] {
    return observations.flatMap((observation): ReceiptAggregationVerdict[] => {
        if (observation.kind === 'ack-rejection') {
            return ['ack-rejection'];
        }
        if (observation.kind === 'ack-count') {
            return observation.ack.ackedMsgId === msgId ? [`ack-count:${observation.outcome}`] : [];
        }
        return observation.kind === 'receipt-outbox' && observation.receipt.msgId === msgId
            ? [`receipt-outbox:${observation.receipt.phase}:${observation.verdict.kind}`]
            : [];
    }).sort();
}

export function toReceiptSets(
    receipt: ALReceiptPayload
): Pick<ALReceiptPayload, 'expectedRecipientPeerIds' | 'confirmedRecipientPeerIds' | 'outsideAudienceRecipientPeerIds'> {
    const { expectedRecipientPeerIds, confirmedRecipientPeerIds, outsideAudienceRecipientPeerIds } = receipt;
    return { expectedRecipientPeerIds, confirmedRecipientPeerIds, outsideAudienceRecipientPeerIds };
}

/** Runs A's real dequeue task, then B's real send task; neither engine starts a timer loop. */
export async function runReceiptWorkerHandoff(input: ReceiptWorkerHandoffInput): Promise<ReceiptWorkerHandoffResult> {
    const bus = createBridgeBus();
    const engineA = new InboxOutboxEngine();
    const engineB = new InboxOutboxEngine();
    const runA = captureOutboundWorkRunnable(engineA);
    const runB = captureOutboundWorkRunnable(engineB);
    const roomPeerIds = ['a', 'b', 'c'];
    // Each instance keeps its own inbound admissions and receipt record: only the outbound pair is under test here.
    const local = await createClusterInstance({
        name: 'server',
        outboundStores: input.storesA,
        ...createReceiptInstanceStores(createReceiptClusterState(Date.now), Date.now),
        inboundVolatileStores: undefined,
        receiptObserver: undefined,
        roomView: { inSync: true },
        bus,
        publisherId: 'local',
        engine: engineA,
        roomPeerIds
    });
    const remote = await createClusterInstance({
        name: 'remote-server',
        outboundStores: input.storesB,
        ...createReceiptInstanceStores(createReceiptClusterState(Date.now), Date.now),
        inboundVolatileStores: undefined,
        receiptObserver: undefined,
        roomView: { inSync: true },
        bus,
        publisherId: 'remote',
        engine: engineB,
        roomPeerIds
    });
    const alice = await connect(local, 'a');
    const wrong = await connect(remote, 'wrong');
    const claims: ReceiptWorkClaim[] = [];
    let worker: 'A' | 'B' = 'A';
    holdReceiptWorkForWorker({ ...input, claims, readWorker: () => worker });
    expect((await local.service.acceptIncomingMessage(roomMessage(toHandoffRoomMessageInput(input.nowMs)), 'a')).right?.kind)
        .toBe('admitted');
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

/** The room message the handoff and its storage cleanup name. */
export function toHandoffRoomMessageInput(nowMs: number): RoomMessageInput {
    return { msgId: 'room-message-1', originPeerId: 'a', nowMs, lifetimeMs: 30_000 };
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

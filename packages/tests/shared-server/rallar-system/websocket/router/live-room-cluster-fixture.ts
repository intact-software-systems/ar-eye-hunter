import { Temporal } from '@js-temporal/polyfill';
import { onTestFinished } from 'vitest';

import { installLiveWsNoticeSubscriber, sendReceivedLiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import type { LiveWsNotice, LiveWsNoticeTransport } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import type { RallarServerWsRoomAuthorizer } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend, type ALAdmissionMemoryState } from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores, createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createActiveGroupPresenceSessionFixture } from '../../../../shared-web/authoritative-group-fixtures.ts';
import type { SimulatedWebSocket } from '../../../../shared/native-websocket-fixture.ts';
import {
    connect,
    createBridgeBus,
    createReceiptClusterState,
    createReceiptInstanceStores,
    installClock,
    RECEIPT_SERVER_PEER_ID,
    type ClusterInstance,
    type ReceiptClock,
    type ReceiptClusterState,
    type ReceiptInstanceStores
} from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';

export type LiveRoomInstanceName = 'a' | 'b';

/** One WS server of the cluster: the real service with the real router installed on it, and its own stores. */
export interface LiveRoomInstance extends ClusterInstance {
    readonly name: LiveRoomInstanceName;
    readonly stores: ReceiptInstanceStores;
    /** The instance's own memory pair; undefined in a cluster, where every room message takes the shared store. */
    readonly volatileStores: ALVolatileInboundRuntimeStores | undefined;
    /** The msgIds the room topic's handler was handed on this instance, in the order it was handed them. */
    readonly handledMsgIds: readonly string[];
}

/** The in-memory stand-in for `pg_notify`: every notice published, and the two ways to lose one. */
export interface LiveNoticeBus {
    readonly notices: readonly LiveWsNotice[];
    /** The next publish throws, as a failed NOTIFY does; the notice is recorded nowhere. */
    failNextPublish(): void;
    /** Until `deliverToAll`, the instance's listener receives no notice; each is still published. */
    withholdFrom(name: LiveRoomInstanceName): void;
    deliverToAll(): void;
}

/** Two instances sharing the inbound store, the receipt record and the outbox, as two api-v1 processes share PostgreSQL. */
export interface LiveRoomClusterFixture {
    readonly clock: ReceiptClock;
    readonly state: ReceiptClusterState;
    readonly bus: LiveNoticeBus;
    readonly instances: Readonly<Record<LiveRoomInstanceName, LiveRoomInstance>>;
}

export interface CreateLiveRoomClusterFixtureInput {
    /** The room's sessions: the authorizer admits a room message to exactly these, whether a socket is open or not. */
    readonly roomSessionIds: readonly string[];
    /** Each instance keeps a room message in a memory pair of its own, as a server of one process does. */
    readonly volatileInbound: boolean;
}

/** The clock step of `advanceLiveRoomClock`; both engines run after each step. */
export const LIVE_ROOM_CLOCK_STEP_MS = 500;

/** The receipt fixture's room: its `roomMessage` is a send to this room on this implicit topic. */
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROOM_TOPIC_ID = 'room.notification';
const SNAPSHOT_VERSION = 3;
const NOTICE_CHANNEL = 'live-room-cluster';
const BRIDGE_CHANNEL = 'live-room-cluster-outbox';
const ENGINE_ROUNDS = 6;

interface CreateLiveRoomInstanceInput {
    readonly name: LiveRoomInstanceName;
    readonly clock: ReceiptClock;
    readonly state: ReceiptClusterState;
    readonly outbound: ALAdmissionMemoryState;
    readonly noticeTransport: LiveWsNoticeTransport;
    readonly bridge: QueueBoxPubSubBridge;
    readonly cluster: CreateLiveRoomClusterFixtureInput;
}

interface LiveNoticeBusState {
    readonly bus: LiveNoticeBus;
    toTransport(name: LiveRoomInstanceName): LiveWsNoticeTransport;
}

/** Engines are not started: a case moves the clock and runs both engines itself, so every run is the same. */
export async function createLiveRoomClusterFixture(input: CreateLiveRoomClusterFixtureInput): Promise<LiveRoomClusterFixture> {
    const clock = installClock();
    const state = createReceiptClusterState(() => clock.nowMs);
    const outbound = createInMemoryALAdmissionState(new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs)));
    const notices = createLiveNoticeBus();
    const bridge = createBridgeBus();
    const shared = { clock, state, outbound, bridge, cluster: input };
    const a = await createLiveRoomInstance({ ...shared, name: 'a', noticeTransport: notices.toTransport('a') });
    const b = await createLiveRoomInstance({ ...shared, name: 'b', noticeTransport: notices.toTransport('b') });
    return { clock, state, bus: notices.bus, instances: { a, b } };
}

/** Opens `sessionId`'s socket on the instance; a frame `losesFrame` names is lost after the server wrote it. */
export async function connectLiveRoomSession(
    instance: LiveRoomInstance,
    sessionId: string,
    losesFrame: (frame: ALMessage) => boolean
): Promise<SimulatedWebSocket> {
    const socket = await connect(instance, sessionId);
    const send = socket.send.bind(socket);
    socket.send = (frame) => losesFrame(decodePersistedALMessage(String(frame))) ? String(frame).length : send(frame);
    return socket;
}

/** Runs instance a's engine, then b's, each until its work has settled: a claims any work both could. */
export async function settleLiveRoomCluster(fixture: LiveRoomClusterFixture): Promise<void> {
    for (let round = 0; round < ENGINE_ROUNDS; round += 1) {
        for (const instance of [fixture.instances.a, fixture.instances.b]) {
            await instance.engine.executeOnce();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
}

/** Moves the clock `durationMs` forward in steps of `LIVE_ROOM_CLOCK_STEP_MS`, settling the cluster after each. */
export async function advanceLiveRoomClock(fixture: LiveRoomClusterFixture, durationMs: number): Promise<void> {
    for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += LIVE_ROOM_CLOCK_STEP_MS) {
        fixture.clock.nowMs += Math.min(LIVE_ROOM_CLOCK_STEP_MS, durationMs - elapsedMs);
        await settleLiveRoomCluster(fixture);
    }
}

/** The msgIds of the data frames a socket was written, in order; controls (receipts, ACKs, NACKs) are left out. */
export function readDataCopies(socket: SimulatedWebSocket): readonly string[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => !isALControlTypeId(message.payload.typeId))
        .map((message) => message.id.msgId);
}

/** The status of every inbound delivery work row the cluster's shared store holds. */
export async function readDeliveryWorkStatuses(fixture: LiveRoomClusterFixture): Promise<readonly string[]> {
    const workQueue = fixture.state.inbound.workQueue;
    const entries = await Promise.all((await workQueue.getAllKeys()).map(async (key) => await workQueue.getItem(key)));
    return entries.map((entry) => `${entry?.status}`);
}

async function createLiveRoomInstance(input: CreateLiveRoomInstanceInput): Promise<LiveRoomInstance> {
    const nowMs = () => input.clock.nowMs;
    const server = new JsonWebSocketServer();
    const engine = new InboxOutboxEngine();
    const stores = createReceiptInstanceStores(input.state, nowMs);
    const volatileStores = input.cluster.volatileInbound ? createVolatileALInboundRuntimeStores({ nowMs }, undefined) : undefined;
    const service = createLiveRoomService({ input, server, engine, stores, volatileStores });
    onTestFinished(async () => {
        await Promise.allSettled([service.dispose(), engine.stop()]);
    });
    const handledMsgIds: string[] = [];
    const router = new RallarServerWsRouter(service, {
        grantedTopics: new WsGrantedTopicSet(),
        nowEpochMs: nowMs,
        livePublication: { transport: input.noticeTransport, channel: NOTICE_CHANNEL, publisherId: input.name },
        authorizeRoomMessage: toFixedRoomAuthorizer(input.cluster.roomSessionIds)
    }).install();
    router.on({ topicId: ROOM_TOPIC_ID }, (message) => {
        handledMsgIds.push(message.raw.id.msgId);
    });
    await installLiveWsNoticeSubscriber({
        transport: input.noticeTransport,
        channel: NOTICE_CHANNEL,
        publisherId: input.name,
        nowMs,
        inboundStores: [stores.inboundStores.admissionStore],
        resolveBroadRecipientSessionIds: () => readOpenSessionIds(server),
        filterEligibleRecipientSessionIds: (sessionIds) => sessionIds.filter((sessionId) => server.connections.get(sessionId)?.isOpen === true),
        sendToTargetsWithResult: (delivery) => sendReceivedLiveWsNotice(service, delivery)
    });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: service, bridge: input.bridge, channel: BRIDGE_CHANNEL, publisherId: input.name });
    return { name: input.name, service, engine, server, stores, volatileStores, handledMsgIds };
}

interface CreateLiveRoomServiceInput {
    readonly input: CreateLiveRoomInstanceInput;
    readonly server: JsonWebSocketServer;
    readonly engine: InboxOutboxEngine;
    readonly stores: ReceiptInstanceStores;
    readonly volatileStores: ALVolatileInboundRuntimeStores | undefined;
}

/** Every instance of one deployment shares the server's name, as api-v1's instances share `wsRuntimeName`. */
function createLiveRoomService({ input, server, engine, stores, volatileStores }: CreateLiveRoomServiceInput): WsQueueBoxServerService {
    const nowMs = () => input.clock.nowMs;
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        outboundBackend: new InMemoryAdmissionBackend(input.outbound, nowMs)
    });
    const openRecipients = () => readOpenSessionIds(server).map((sessionId) => ({ peerId: sessionId, connectionId: sessionId }));
    return createDefaultWsQueueBoxServerService({
        ...stores,
        inboundVolatileStores: volatileStores,
        outbox: outboundStores.workQueue,
        outboundStores,
        socket: server,
        name: RECEIPT_SERVER_PEER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            server.connections.get(connection.id) === connection
                ? { scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        targetResolver: {
            requiresFrozenAudience: () => false,
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => openRecipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: () => openRecipients().filter((recipient) => input.cluster.roomSessionIds.includes(recipient.peerId))
        }
    });
}

/** Admits every room message to the fixed room and reads nothing; a message with no targets is refused. */
function toFixedRoomAuthorizer(roomSessionIds: readonly string[]): RallarServerWsRoomAuthorizer {
    const sessions = roomSessionIds.map((sessionId) => createActiveGroupPresenceSessionFixture({ ...ROOM, principalId: sessionId, sessionId }));
    return ({ message }) =>
        message.targets === undefined ? false : {
            authorized: true,
            audience: { targets: message.targets, sessions, snapshotVersion: SNAPSHOT_VERSION, recipientConnectionGenerationIds: {} }
        };
}

function readOpenSessionIds(server: JsonWebSocketServer): readonly string[] {
    return [...server.connections.values()].filter((connection) => connection.isOpen).map((connection) => connection.id);
}

function createLiveNoticeBus(): LiveNoticeBusState {
    const notices: LiveWsNotice[] = [];
    const listeners = new Map<LiveRoomInstanceName, (notice: LiveWsNotice) => Promise<void> | void>();
    const withheld = new Set<LiveRoomInstanceName>();
    let failures = 0;
    const publish = async (notice: LiveWsNotice): Promise<void> => {
        if (failures > 0) {
            failures -= 1;
            throw new Error('NOTIFY failed');
        }
        notices.push(notice);
        for (const [name, listener] of listeners) {
            if (!withheld.has(name)) {
                await listener(notice);
            }
        }
    };
    const bus: LiveNoticeBus = {
        notices,
        failNextPublish: () => {
            failures += 1;
        },
        withholdFrom: (name) => {
            withheld.add(name);
        },
        deliverToAll: () => {
            withheld.clear();
        }
    };
    return {
        bus,
        toTransport: (name) => ({
            publish,
            subscribe: async (_channel, onNotice) => {
                listeners.set(name, onNotice);
            }
        })
    };
}

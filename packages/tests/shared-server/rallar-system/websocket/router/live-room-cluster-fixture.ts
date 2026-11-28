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
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
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
    roomMessage,
    type ClusterInstance,
    type ReceiptClock,
    type ReceiptClusterState,
    type ReceiptInstanceStores
} from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';

export type LiveRoomInstanceName = 'a' | 'b';

/** One instance's own store objects over the state the cluster shares, memory or PostgreSQL. */
export interface LiveRoomInstanceStores extends ReceiptInstanceStores {
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    /** The instance's own memory pair; undefined in a cluster, where every room message takes the shared store. */
    readonly volatileStores: ALVolatileInboundRuntimeStores | undefined;
}

/** One WS server of the cluster: the real service with the real router installed on it, and its own stores. */
export interface LiveRoomInstance extends ClusterInstance {
    readonly stores: LiveRoomInstanceStores;
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

/** What the repair of a missed copy will read of a send: its envelope, and the audience it was admitted to by both reads. */
export interface LiveRoomStoredCopy {
    readonly envelope: ALMessage | undefined;
    readonly sourceAudience: readonly string[] | undefined;
    readonly ingressAudience: readonly string[] | undefined;
}

export interface CreateLiveRoomClusterFixtureInput {
    /** The room's sessions: the authorizer admits a room message to exactly these, whether a socket is open or not. */
    readonly roomSessionIds: readonly string[];
    /** Each instance keeps a room message in a memory pair of its own, as a server of one process does. */
    readonly volatileInbound: boolean;
}

export interface CreateLiveRoomInstanceInput {
    /** The instance's publisher id on the notice bus and the outbox bridge. */
    readonly publisherId: string;
    readonly nowMs: () => number;
    readonly stores: LiveRoomInstanceStores;
    readonly noticeTransport: LiveWsNoticeTransport;
    readonly bridge: QueueBoxPubSubBridge;
    /** The room's sessions: the authorizer admits a room message to exactly these. */
    readonly roomSessionIds: readonly string[];
}

/** The first `copies` frames of one message a socket loses after the server wrote them; every later copy arrives. */
export interface LiveRoomCopyLoss {
    readonly msgId: string;
    readonly copies: number;
}

/** One receipted room send of `LIVE_ROOM_ORIGIN`'s, sent at `nowMs`. */
export interface LiveRoomSendInput {
    readonly msgId: string;
    readonly nowMs: number;
    readonly lifetimeMs: number;
}

/** The session every case sends from. */
export const LIVE_ROOM_ORIGIN = 'p';
/** The room most cases use: the origin and two recipients, `r1` and `r2`; each case chooses their instances. */
export const LIVE_ROOM_SESSION_IDS: readonly string[] = [LIVE_ROOM_ORIGIN, 'r1', 'r2'];

/** The receipt fixture's room: its `roomMessage` is a send to this room on this implicit topic. */
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROOM_TOPIC_ID = 'room.notification';
const SNAPSHOT_VERSION = 3;
const NOTICE_CHANNEL = 'live-room-cluster';
const BRIDGE_CHANNEL = 'live-room-cluster-outbox';
/** The clock step of `advanceLiveRoomClock`; the cluster settles after each step. */
const CLOCK_STEP_MS = 500;
/** A bound, not a budget: a cluster that still starts work after this many rounds fails the case. */
const MAX_SETTLE_ROUNDS = 64;

interface MemoryInstanceStoresInput {
    readonly state: ReceiptClusterState;
    readonly outbound: ALAdmissionMemoryState;
    readonly nowMs: () => number;
    readonly volatileInbound: boolean;
}

interface LiveNoticeBusState {
    readonly bus: LiveNoticeBus;
    createTransport(name: LiveRoomInstanceName): LiveWsNoticeTransport;
}

interface CreateLiveRoomServiceInput {
    readonly instance: CreateLiveRoomInstanceInput;
    readonly server: JsonWebSocketServer;
    readonly engine: InboxOutboxEngine;
}

/** Engines are not started: a case moves the clock and settles both engines itself, so every run is the same. */
export async function createLiveRoomClusterFixture(input: CreateLiveRoomClusterFixtureInput): Promise<LiveRoomClusterFixture> {
    const clock = installClock();
    const nowMs = () => clock.nowMs;
    const state = createReceiptClusterState(nowMs);
    const outbound = createInMemoryALAdmissionState(new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs)));
    const notices = createLiveNoticeBus();
    const shared = { nowMs, bridge: createBridgeBus(), roomSessionIds: input.roomSessionIds };
    const storesInput = { state, outbound, nowMs, volatileInbound: input.volatileInbound };
    const a = await createLiveRoomInstance({
        ...shared,
        publisherId: 'a',
        stores: createMemoryInstanceStores(storesInput),
        noticeTransport: notices.createTransport('a')
    });
    const b = await createLiveRoomInstance({
        ...shared,
        publisherId: 'b',
        stores: createMemoryInstanceStores(storesInput),
        noticeTransport: notices.createTransport('b')
    });
    return { clock, state, bus: notices.bus, instances: { a, b } };
}

/** One instance; its engine is not started. The test's end disposes its service, stops its engine and rethrows a failure. */
export async function createLiveRoomInstance(input: CreateLiveRoomInstanceInput): Promise<LiveRoomInstance> {
    const { nowMs, stores } = input;
    const server = new JsonWebSocketServer();
    const engine = new InboxOutboxEngine();
    const service = createLiveRoomService({ instance: input, server, engine });
    onTestFinished(async () => {
        const failure = (await Promise.allSettled([service.dispose(), engine.stop()])).find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    });
    const handledMsgIds: string[] = [];
    const router = new RallarServerWsRouter(service, {
        grantedTopics: new WsGrantedTopicSet(),
        nowEpochMs: nowMs,
        livePublication: { transport: input.noticeTransport, channel: NOTICE_CHANNEL, publisherId: input.publisherId },
        authorizeRoomMessage: createFixedRoomAuthorizer(input.roomSessionIds)
    }).install();
    router.on({ topicId: ROOM_TOPIC_ID }, (message) => {
        handledMsgIds.push(message.raw.id.msgId);
    });
    await installLiveWsNoticeSubscriber({
        transport: input.noticeTransport,
        channel: NOTICE_CHANNEL,
        publisherId: input.publisherId,
        nowMs,
        inboundStores: [stores.inboundStores.admissionStore],
        resolveBroadRecipientSessionIds: () => getOpenSessionIds(server),
        filterEligibleRecipientSessionIds: (sessionIds) => sessionIds.filter((sessionId) => server.connections.get(sessionId)?.isOpen === true),
        sendToTargetsWithResult: (delivery) => sendReceivedLiveWsNotice(service, delivery)
    });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: service, bridge: input.bridge, channel: BRIDGE_CHANNEL, publisherId: input.publisherId });
    return { service, engine, server, stores, handledMsgIds };
}

/**
 * Opens `sessionId`'s socket on the instance. With a `loss`, the first `copies` frames of that message the server
 * writes are lost after the write; every later copy of it, a copy sent again included, reaches the socket.
 */
export async function connectLiveRoomSession(
    instance: LiveRoomInstance,
    sessionId: string,
    loss: LiveRoomCopyLoss | undefined
): Promise<SimulatedWebSocket> {
    const socket = await connect(instance, sessionId);
    if (loss === undefined) {
        return socket;
    }
    const send = socket.send.bind(socket);
    let lost = 0;
    socket.send = (frame) => {
        if (lost < loss.copies && decodePersistedALMessage(String(frame)).id.msgId === loss.msgId) {
            lost += 1;
            return String(frame).length;
        }
        return send(frame);
    };
    return socket;
}

/** The receipt fixture's room send from `LIVE_ROOM_ORIGIN`: at-least-once, receipted by every receiver. */
export function createLiveRoomSend(input: LiveRoomSendInput): ALMessage {
    return roomMessage({ msgId: input.msgId, originPeerId: LIVE_ROOM_ORIGIN, nowMs: input.nowMs, lifetimeMs: input.lifetimeMs });
}

/**
 * Runs instance a's engine, then b's, with a macrotask after each so the work it started drains, until a round in
 * which neither starts work: a claims any work both could.
 */
export async function settleLiveRoomCluster(fixture: LiveRoomClusterFixture): Promise<void> {
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
        let started = false;
        for (const instance of [fixture.instances.a, fixture.instances.b]) {
            started = await instance.engine.executeOnce() || started;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!started) {
            return;
        }
    }
    throw new Error(`The live room cluster still started work after ${MAX_SETTLE_ROUNDS} rounds`);
}

/** Moves the clock `durationMs` forward in steps of `CLOCK_STEP_MS`, settling the cluster after each. */
export async function advanceLiveRoomClock(fixture: LiveRoomClusterFixture, durationMs: number): Promise<void> {
    for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += CLOCK_STEP_MS) {
        fixture.clock.nowMs += Math.min(CLOCK_STEP_MS, durationMs - elapsedMs);
        await settleLiveRoomCluster(fixture);
    }
}

/** The msgIds of the message frames a socket was written, in order; controls (receipts, ACKs, NACKs) are left out. */
export function getMessageCopies(socket: SimulatedWebSocket): readonly string[] {
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

/** Each send as `store` reads it at `readAtMs`, through the two reads the repair will use. */
export async function readLiveRoomStoredCopies(
    store: Pick<ALInboundAdmissionStore, 'readDeliverySurface' | 'readIngressAudience'>,
    sends: readonly ALMessage[],
    readAtMs: number
): Promise<readonly LiveRoomStoredCopy[]> {
    return await Promise.all(sends.map(async ({ id }): Promise<LiveRoomStoredCopy> => {
        const surface = await store.readDeliverySurface({ senderId: id.senderId, msgId: id.msgId }, readAtMs);
        return {
            envelope: surface?.msg,
            sourceAudience: surface?.source.kind === 'ws-client' ? surface.source.groupRecipientPeerIds : undefined,
            ingressAudience: await store.readIngressAudience(id.msgId, id.senderId)
        };
    }));
}

function createMemoryInstanceStores({ state, outbound, nowMs, volatileInbound }: MemoryInstanceStoresInput): LiveRoomInstanceStores {
    return {
        ...createReceiptInstanceStores(state, nowMs),
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(outbound, nowMs)
        }),
        volatileStores: volatileInbound ? createVolatileALInboundRuntimeStores({ nowMs }, undefined) : undefined
    };
}

/** Every instance of one deployment shares the server's name, as api-v1's instances share `wsRuntimeName`. */
function createLiveRoomService({ instance, server, engine }: CreateLiveRoomServiceInput): WsQueueBoxServerService {
    const { inboundStores, receiptRecordStores, outboundStores, volatileStores } = instance.stores;
    const openRecipients = () => getOpenSessionIds(server).map((sessionId) => ({ peerId: sessionId, connectionId: sessionId }));
    return createDefaultWsQueueBoxServerService({
        inboundStores,
        receiptRecordStores,
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
            resolveBroadcastRecipients: () => openRecipients().filter((recipient) => instance.roomSessionIds.includes(recipient.peerId))
        }
    });
}

/**
 * Admits every room message to the fixed room and reads nothing; a message with no targets is refused. Its sessions
 * never expire, so a path that asks a session's liveness on the fixture's clock finds the whole room live.
 */
function createFixedRoomAuthorizer(roomSessionIds: readonly string[]): RallarServerWsRoomAuthorizer {
    const sessions = roomSessionIds.map((sessionId) => ({
        ...createActiveGroupPresenceSessionFixture({ ...ROOM, principalId: sessionId, sessionId }),
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER
    }));
    return ({ message }) =>
        message.targets === undefined ? false : {
            authorized: true,
            audience: { targets: message.targets, sessions, snapshotVersion: SNAPSHOT_VERSION, recipientConnectionGenerationIds: {} }
        };
}

function getOpenSessionIds(server: JsonWebSocketServer): readonly string[] {
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
        createTransport: (name) => ({
            publish,
            subscribe: async (_channel, onNotice) => {
                listeners.set(name, onNotice);
            }
        })
    };
}

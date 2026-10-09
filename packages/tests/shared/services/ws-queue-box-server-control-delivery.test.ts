import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALAckPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALAckPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend, type ALAdmissionMemoryState } from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { WsQueueBoxServerControlDelivery } from '@shared/services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createOutboundTestRuntimeFor } from '../alm/outbound-runtime-test-fixture.ts';
import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

/** Every instance of one deployment shares this server peer id, as `wsRuntimeName` does in production. */
const SERVER_ID = 'server';
const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room-1' };

interface ControlInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
}

interface ControlClusterFixture {
    /** The instance holding Alice's socket; Alice's message arrives here. */
    readonly owner: ControlInstance;
    /** An instance of the same deployment without Alice's socket, sharing every queue and store. */
    readonly other: ControlInstance | undefined;
    readonly alice: SimulatedWebSocket;
    readonly outbox: InMemoryQueueBox;
    /** Lets the owner's inbound work claim rows; until then only the other instance can. */
    readonly releaseOwnerClaims: () => void;
}

interface SharedStores {
    readonly outbox: InMemoryQueueBox;
    readonly inbound: ALAdmissionMemoryState;
    readonly outbound: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
}

describe('WS server control sends across instances', () => {
    afterEach(() => vi.restoreAllMocks());

    it('hands the ACK to the cluster outbox when the claiming instance holds no socket for its target', async () => {
        const fixture = await createControlClusterFixture({ cluster: true, holdOwnerClaims: true });
        const other = fixture.other!;

        await admitServerAddressedMessage(fixture);

        // The owner's own commit would otherwise start a batch that claims the ACK row before any other
        // instance can, so it reserves nothing until the ACK has arrived.
        await expect.poll(async () => {
            await other.engine.executeOnce();
            return readAcks(fixture.alice).map((ack) => [ack.ackedMsgId, ack.fromPeerId, ack.logicalRecipientPeerId]);
        }).toEqual([['to-server', SERVER_ID, SERVER_ID]]);
        fixture.releaseOwnerClaims();
        await runRounds([other, fixture.owner], 3);
        expect(readAcks(fixture.alice)).toHaveLength(1);
    });

    it('sends the ACK once from the instance holding the socket and hands nothing to the outbox', async () => {
        const fixture = await createControlClusterFixture({ cluster: true });

        await admitServerAddressedMessage(fixture);

        await expect.poll(async () => {
            await fixture.owner.engine.executeOnce();
            return readAcks(fixture.alice).map((ack) => ack.ackedMsgId);
        }).toEqual(['to-server']);
        await runRounds([fixture.owner, fixture.other!], 3);
        expect(readAcks(fixture.alice)).toHaveLength(1);
        expect(await readOutboxAckRows(fixture.outbox)).toEqual([]);
    });

    it('ends a handed-off ACK after one publication when no instance holds its target\'s socket', async () => {
        const fixture = await createControlClusterFixture({ cluster: true });
        const other = fixture.other!;
        const log = vi.spyOn(console, 'log');
        await admitServerAddressedMessage(fixture);
        await fixture.alice.receiveClose(1000, 'gone');

        await expect.poll(async () => {
            await other.engine.executeOnce();
            return (await readOutboxAckRows(fixture.outbox)).map((row) => row.status);
        }).toEqual(['COMPLETED']);
        await runRounds([other, fixture.owner], 3);
        expect((await readOutboxAckRows(fixture.outbox)).map((row) => row.status)).toEqual(['COMPLETED']);
        expect(readAcks(fixture.alice)).toEqual([]);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(
            /^WS server control al\.control\.ack\.v2 \S+ has no socket for a here; handed to the cluster outbox \(admitted\)$/
        ));
    });

    it('keeps an instance without a cluster publisher as it was: it warns and writes no outbox row', async () => {
        const fixture = await createControlClusterFixture({ cluster: false });
        const warn = vi.spyOn(console, 'warn');
        await admitServerAddressedMessage(fixture);
        await fixture.alice.receiveClose(1000, 'gone');

        await expect.poll(async () => {
            await fixture.owner.engine.executeOnce();
            return warn.mock.calls.map(([line]) => line);
        }).toContain(`Cannot resolve WS server control target a for ${AL_CONTROL_ACK_TYPE_ID}`);
        await runRounds([fixture.owner], 3);
        expect(await readOutboxAckRows(fixture.outbox)).toEqual([]);
        expect(readAcks(fixture.alice)).toEqual([]);
    });
});

describe('the cluster hand-off row of a server control', () => {
    afterEach(() => vi.restoreAllMocks());

    it('lives until the control\'s own expiry when it has one, else for 30 s', async () => {
        const handOff = createHandOffFixture();
        const lasting = { ...serverAck('ack-lasting'), constraints: { expiresAtMs: HAND_OFF_NOW_MS + 5_000 } };

        await handOff.delivery.sendControlMessage(serverAck('ack-default'));
        await handOff.delivery.sendControlMessage(lasting);

        expect(await handOff.readRowExpiry('ack-default')).toBe(HAND_OFF_NOW_MS + 30_000);
        expect(await handOff.readRowExpiry('ack-lasting')).toBe(HAND_OFF_NOW_MS + 5_000);
    });

    it('writes one row for a control handed off twice, deduplicated by its msgId', async () => {
        const handOff = createHandOffFixture();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await handOff.delivery.sendControlMessage(serverAck('ack-twice'));
        const rowsAfterFirst = await handOff.readRowKeys();
        await handOff.delivery.sendControlMessage(serverAck('ack-twice'));

        expect(await handOff.readRowExpiry('ack-twice')).toBe(HAND_OFF_NOW_MS + 30_000);
        expect(rowsAfterFirst.length).toBeGreaterThan(0);
        expect(await handOff.readRowKeys()).toEqual(rowsAfterFirst);
    });
});

const HAND_OFF_NOW_MS = 1_800_000_000_000;

interface HandOffFixture {
    readonly delivery: WsQueueBoxServerControlDelivery;
    readRowExpiry(msgId: string): Promise<number | undefined>;
    readRowKeys(): Promise<readonly string[]>;
}

/** A control delivery on an instance without the target's socket, whose outbound owner is real. */
function createHandOffFixture(): HandOffFixture {
    const stores = createDefaultInMemoryALOutboundRuntimeStores({
        nowMs: () => HAND_OFF_NOW_MS,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const runtime = createOutboundTestRuntimeFor<WsQueueBoxServerPreparedMessage>({
        decodePreparedMessage: decodeWsQueueBoxServerPreparedMessage,
        stores,
        nowMs: () => HAND_OFF_NOW_MS,
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const delivery = new WsQueueBoxServerControlDelivery({
        clock: { nowMs: () => HAND_OFF_NOW_MS },
        liveDelivery: { sendToResolvedPeer: () => 0 },
        clusterPublication: { hasPublisher: () => true },
        outbound: runtime
    });
    return {
        delivery,
        readRowExpiry: async (msgId) => (await stores.admissionStore.readSentMessage(msgId))?.msg.constraints?.expiresAtMs,
        readRowKeys: async () => (await stores.workQueue.getAllKeys()).map((key) => JSON.stringify(key))
    };
}

function serverAck(msgId: string): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId, senderId: SERVER_ID, ts: HAND_OFF_NOW_MS },
        {
            ackedMsgId: 'to-server',
            fromPeerId: SERVER_ID,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: SERVER_ID,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: HAND_OFF_NOW_MS
        }
    );
}

async function createControlClusterFixture(
    options: Readonly<{ cluster: boolean; holdOwnerClaims?: boolean; }>
): Promise<ControlClusterFixture> {
    const nowMs = Date.now;
    const outbox = new InMemoryQueueBox(new Map());
    const stores: SharedStores = {
        outbox,
        inbound: createInMemoryALAdmissionState(new InMemoryQueueBox()),
        outbound: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), nowMs)
        })
    };
    const alice = new SimulatedWebSocket('ws://alice');
    await alice.open();
    let ownerClaimsHeld = options.holdOwnerClaims === true;
    const releaseOwnerClaims = () => {
        ownerClaimsHeld = false;
    };
    const owner = createControlInstance(stores, [new ConnectionContext({ id: 'a', socket: alice })], () => ownerClaimsHeld);
    if (!options.cluster) {
        return { owner, other: undefined, alice, outbox, releaseOwnerClaims };
    }
    const other = createControlInstance(stores, []);
    await installTestClusterBus([owner, other]);
    return { owner, other, alice, outbox, releaseOwnerClaims };
}

/** The same shared work queue, which reserves nothing for this instance while `isHeld()` is true. */
function holdWorkQueueClaims(shared: InMemoryQueueBox, isHeld: (() => boolean) | undefined): InMemoryQueueBox {
    if (isHeld === undefined) {
        return shared;
    }
    const claimMethods = new Set<PropertyKey>(['reserveEntries', 'reserveTimeoutEntries', 'reserveOverdueRetryEntries']);
    return new Proxy(shared, {
        get: (target, property) => {
            const member = Reflect.get(target, property, target);
            if (typeof member !== 'function') {
                return member;
            }
            return claimMethods.has(property)
                ? async (...args: object[]) => isHeld() ? new Map() : await member.apply(target, args)
                : member.bind(target);
        }
    });
}

function createControlInstance(
    stores: SharedStores,
    connections: readonly ConnectionContext[],
    isClaimHeld?: () => boolean
): ControlInstance {
    const socket = new JsonWebSocketServer();
    for (const connection of connections) {
        socket.addConnection(connection);
    }
    const recipients = () => [...socket.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: stores.outbox,
        socket,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            socket.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Date.now() + 60_000 }
                : undefined,
        targetResolver: {
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        },
        inboundStores: {
            admissionStore: createALInboundAdmissionStore({
                namespace: 'ws-server-control',
                nowMs: Date.now,
                backend: new InMemoryAdmissionBackend(stores.inbound, Date.now),
                orderingTrackTtlMs: 300000,
                supersedenceTrackTtlMs: 300000,
                retention: normalizeALRuntimeStoreRetention(),
                maxOrderingTracks: undefined
            }),
            workQueue: holdWorkQueueClaims(stores.inbound.workQueue, isClaimHeld)
        },
        outboundStores: stores.outbound
    });
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? { authorized: true, roomAudience: { recipientPeerIds: ['a'], snapshotVersion: 1 } }
                : { authorized: true }
    });
    // Every instance runs the router; a message addressed to the server has no fanout.
    service.onAnyInboxMessageDo('router', { onMessage: async () => {} });
    onTestFinished(() => service.dispose());
    return { service, engine };
}

async function installTestClusterBus(instances: readonly ControlInstance[]): Promise<void> {
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    const bus: QueueBoxPubSubBridge = {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
        }
    };
    for (const [index, instance] of instances.entries()) {
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: instance.service,
            bridge: bus,
            channel: 'ws',
            publisherId: `instance-${index}`
        });
    }
}

async function admitServerAddressedMessage(fixture: ControlClusterFixture): Promise<void> {
    const nowMs = Date.now();
    const message: ALMessage = {
        id: { v: 3, msgId: 'to-server', ts: nowMs, senderId: 'a' },
        route: { topicId: 'room.command', resourceId: 'to-server', contextId: ROOM.groupId },
        targets: { mode: 'unicast', toPeerId: SERVER_ID, groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'command.v1', contentType: 'application/json', resource: '{}' }
    };
    const admitted = await fixture.owner.service.acceptIncomingMessage(message, 'a');
    expect(admitted.right?.kind).toBe('admitted');
}

async function runRounds(instances: readonly ControlInstance[], rounds: number): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
        for (const instance of instances) {
            await instance.engine.executeOnce();
        }
    }
}

function readAcks(socket: SimulatedWebSocket): readonly ALAckPayload[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID)
        .map((message) => decodeALAckPayload(JSON.parse(message.payload.resource)));
}

/** The outbox rows that carry a server ACK, as the cluster publication would find them. */
async function readOutboxAckRows(outbox: InMemoryQueueBox): Promise<readonly ResourceEntry[]> {
    const entries = await Promise.all((await outbox.getAllKeys()).map((key) => outbox.getItem(key)));
    return entries.flatMap((entry) =>
        entry?.typeId === EnqueuedType.WS_OUTBOX &&
            decodePersistedALMessage(entry.resource).payload.typeId === AL_CONTROL_ACK_TYPE_ID
            ? [entry]
            : []
    );
}

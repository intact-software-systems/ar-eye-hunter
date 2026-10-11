import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { createApiV1WsReceiptObserver } from '../../../apps/api-v1/src/composition/create-api-v1-ws-receipt-observer.ts';
import { createConsoleRallarTimingSink } from '../../shared-server/rallar-system/observability/timing.ts';
import { installQueueBoxPubSubBridge } from '../../shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '../../shared/al-contracts/al-carrier-capabilities.ts';
import { isRoomScopedALMessage, type ALMessage } from '../../shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, newALAckControlMessage } from '../../shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../../shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '../../shared/alm/ALStoreRetention.ts';
import { createDefaultALInboundRuntimeResources } from '../../shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '../../shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundCanonicalKey } from '../../shared/alm/outbound/al-outbound-canonical-message.ts';
import { computeALOutboundDispatch } from '../../shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '../../shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '../../shared/api/api-config.ts';
import { Either } from '../../shared/resilience/Either.ts';
import { InboxOutboxEngine } from '../../shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '../../shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '../../shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '../../shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import type { WsQueueBoxServerReceiptObservation } from '../../shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { WsQueueBoxServerService } from '../../shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '../../shared/websocket/json-web-socket-server.ts';
import { SimulatedWebSocket } from '../shared/native-websocket-fixture.ts';

const scope = { applicationId: 'app', workspaceId: 'workspace' };

async function commitCompetitor(store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>, message: ALMessage) {
    const competitor = { ...message, id: { ...message.id, msgId: 'competing-version' } };
    const read = await store.readOutgoingMessage({
        msg: competitor,
        planner: (msg) => ({ msg, lane: 'durable', dropReasonCode: undefined, preparedMessages: [] }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: {
            ...QueueBoxUtilities.toResourceEntryFromMsg(competitor, EnqueuedType.WS_OUTBOX),
            key: toALOutboundCanonicalKey(store.canonicalScope, competitor)
        },
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
    assert.ok(computed.bundle);
    return computed.bundle;
}

function subject(): ALMessage {
    return {
        id: { v: 3, msgId: 'subject', senderId: 'origin', ts: Date.now() },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: 'room' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { ...scope, groupId: 'room' } },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

async function createSocket() {
    const socket = new JsonWebSocketServer();
    const origin = new SimulatedWebSocket('ws://origin');
    const recipient = new SimulatedWebSocket('ws://recipient');
    await origin.open();
    await recipient.open();
    socket.addConnection(new ConnectionContext({ id: 'origin', socket: origin }));
    socket.addConnection(new ConnectionContext({ id: 'recipient', socket: recipient }));
    return { socket, origin };
}

export type ReceiptOwnerScenario = 'native-return' | 'later-throw' | 'closed' | 'native-throw' | 'publish-return' | 'publish-throw' | 'direct-failure';

export type ReceiptOwnerSink = 'collecting' | 'mutating' | 'throwing' | 'disabled' | 'unsafe' | 'unsafe-transport' | 'unsafe-publication' | 'clock-mutating';

interface ReceiptFixtureClock {
    nowMs: number;
    reads: number;
}

export async function writePendingReceiptOwnerEvidence(
    evidencePath: string,
    scenario: ReceiptOwnerScenario = 'native-return',
    sink: ReceiptOwnerSink = 'collecting'
): Promise<void> {
    const actualNow = Date.now;
    const clock: ReceiptFixtureClock = { nowMs: 1700000000000, reads: 0 };
    Date.now = () => clock.nowMs;
    try {
        const fixture = new ReceiptOwnerFixture(await createSocket(), clock, sink);
        try {
            await fixture.run(evidencePath, scenario);
        }
        finally {
            fixture.dispose();
        }
    }
    finally {
        Date.now = actualNow;
    }
}

/** Owns only test ports and independent effects; production owns every admission, claim and send. */
class ReceiptOwnerFixture {
    readonly backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    readonly store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'receipt-owner',
        namespace: 'receipt-owner',
        backend: this.backend,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    readonly effects = {
        conflicted: false,
        receiptControlMsgId: '',
        nativeCalls: 0,
        publications: 0,
        receiptKey: '',
        clockReads: 0,
        releases: 0,
        lastReceiptReleaseAtMs: 0,
        receiptReleaseStatuses: [] as string[],
        mutationResults: [] as boolean[]
    };
    readonly observations: WsQueueBoxServerReceiptObservation[] = [];
    readonly engine = new InboxOutboxEngine();
    readonly service: WsQueueBoxServerService;
    readonly socket: JsonWebSocketServer;
    readonly origin: SimulatedWebSocket;
    readonly clock: ReceiptFixtureClock;
    readonly sink: ReceiptOwnerSink;
    readonly reserve = this.backend.workQueue.reserveEntries.bind(this.backend.workQueue);
    readonly recover = this.backend.workQueue.reserveTimeoutEntries.bind(this.backend.workQueue);
    readonly observer: ReturnType<typeof createApiV1WsReceiptObserver>;
    readonly observe: ((event: WsQueueBoxServerReceiptObservation) => void) | undefined;

    constructor(sockets: { socket: JsonWebSocketServer; origin: SimulatedWebSocket; }, clock: ReceiptFixtureClock, sink: ReceiptOwnerSink) {
        this.socket = sockets.socket;
        this.origin = sockets.origin;
        this.clock = clock;
        this.sink = sink;
        this.observer = createApiV1WsReceiptObserver({
            enabled: sink !== 'disabled',
            timing: createConsoleRallarTimingSink({ enabled: true }),
            serviceId: 'api-process',
            publisherId: 'publisher-1'
        });
        this.observe = sink === 'disabled' ? undefined : (event) => this.recordObservation(event);
        this.holdClaims();
        installReceiptConflict(this.store, this.effects);
        this.service = this.createServer();
        this.service.authorizeInboundMessagesWith({
            authorize: async (message) =>
                isRoomScopedALMessage(message)
                    ? ({ authorized: true, roomAudience: { recipientPeerIds: ['recipient'], snapshotVersion: 7 } })
                    : ({ authorized: true }),
            sendNacks: false
        });
    }

    private createServer(): WsQueueBoxServerService {
        return new WsQueueBoxServerService({
            name: 'server',
            socket: this.socket,
            qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, undefined),
            inboundRuntime: createDefaultALInboundRuntimeResources({
                queueEngine: this.engine,
                selfPeerId: 'server',
                toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX)
            }),
            outboundRuntime: createDefaultALOutboundRuntimeResources({
                queueEngine: this.engine,
                stores: { admissionStore: this.store, workQueue: this.backend.workQueue },
                decodePrepared: decodeWsQueueBoxServerPreparedMessage,
                nowMs: () => {
                    this.clock.reads += 1;
                    return this.clock.nowMs;
                }
            }),
            dequeueResilience: createDefaultALOutboundDequeueResilience(),
            receiptObserver: this.observe,
            readAuthenticatedConnectionScope: () => ({ scope, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }),
            targetResolver: {
                resolveBroadcastRecipients: () => [{ peerId: 'recipient', connectionId: 'recipient' }],
                resolvePeerRecipients: (peerId) => this.socket.connections.get(peerId)?.isOpen ? [{ peerId, connectionId: peerId }] : []
            },
            readProducerProvenance: undefined,
            outboundDiagnostics: undefined,
            outboundSettlements: undefined,
            inboundDiagnostics: undefined,
            outboundDeliveryOutcome: undefined,
            deliveryDiagnostics: undefined,
            validateInboundMessage: Either.ofRight,
            publishRelayedAck: undefined,
            forwardsRoomScopedMessages: true
        });
    }

    async run(evidencePath: string, scenario: ReceiptOwnerScenario): Promise<void> {
        await generateCompleteReceipt(this.service);
        const pending = this.observations.find((event) => event.kind === 'receipt-outbox' && event.receipt.phase === 'complete');
        if (this.sink !== 'disabled') {
            assert.equal(pending?.kind === 'receipt-outbox' && pending.verdict.kind, 'pending');
        }
        assert.equal(this.effects.conflicted, true);
        assert.equal(await this.store.readSentMessage(this.effects.receiptControlMsgId), undefined);
        assert.equal(this.origin.sent.length, 0);
        this.configureNative(scenario);
        if (scenario.startsWith('publish') || scenario === 'direct-failure') {
            await this.installPublication(scenario);
        }
        this.backend.workQueue.reserveEntries = this.reserve;
        this.backend.workQueue.reserveTimeoutEntries = this.recover;
        await drainReceipt(this.engine, () =>
            this.origin.sent.some((text) => text.includes(this.effects.receiptControlMsgId)) ||
            this.observations.some((event) => event.kind === 'receipt-transport' && event.receiptControlMsgId === this.effects.receiptControlMsgId));
        this.assertTransportEffects(scenario);
        this.clock.nowMs = 1700000000000;
        assert.ok(await this.store.readSentMessage(this.effects.receiptControlMsgId));
        this.effects.clockReads = this.clock.reads;
        await writeFile(evidencePath, JSON.stringify(this.effects));
    }

    dispose(): void {
        this.service.dispose();
        this.engine.stop();
    }

    private holdClaims(): void {
        this.backend.workQueue.reserveEntries = async () => new Map();
        this.backend.workQueue.reserveTimeoutEntries = async () => new Map();
        const release = this.backend.workQueue.releaseEntries.bind(this.backend.workQueue);
        this.backend.workQueue.releaseEntries = async (releases) => {
            if (releases.some((value) => value.entry.resource.includes(this.effects.receiptControlMsgId))) {
                this.effects.lastReceiptReleaseAtMs = Date.now();
            }
            const result = await release(releases);
            this.effects.releases += releases.length;
            for (const entry of result.values()) {
                if (entry.resource.includes(this.effects.receiptControlMsgId)) {
                    this.effects.receiptReleaseStatuses.push(entry.status);
                }
            }
            return result;
        };
    }

    private recordObservation(event: WsQueueBoxServerReceiptObservation): void {
        this.observations.push(event);
        this.observer?.(this.toCapturedObservation(event));
        if ('receipt' in event && this.sink === 'mutating') {
            this.effects.mutationResults.push(Reflect.set(event.receipt.confirmedRecipientPeerIds, '0', 'forged'));
            this.effects.mutationResults.push(Reflect.set(event, 'receiptControlMsgId', 'forged'));
        }
        if (this.sink === 'clock-mutating' && event.kind === 'receipt-transport' && event.receiptControlMsgId === this.effects.receiptControlMsgId) {
            this.clock.nowMs += 90_000;
        }
        if (this.sink === 'throwing') {
            throw new Error('observer failure');
        }
    }

    private toCapturedObservation(event: WsQueueBoxServerReceiptObservation): WsQueueBoxServerReceiptObservation {
        if (this.sink === 'unsafe' && event.kind === 'receipt-work') {
            return { ...event, workLocator: 'unsafe identity sentinel' };
        }
        if (this.sink === 'unsafe-transport' && event.kind === 'receipt-transport') {
            return { ...event, connectionId: 'unsafe identity sentinel' };
        }
        if (this.sink === 'unsafe-publication' && event.kind === 'receipt-publication') {
            return { ...event, publisherId: 'unsafe identity sentinel' };
        }
        return event;
    }

    private configureNative(scenario: ReceiptOwnerScenario): void {
        const nativeSend = this.origin.send.bind(this.origin);
        this.origin.send = (data) => {
            this.effects.nativeCalls += 1;
            if (scenario === 'native-throw' || scenario === 'direct-failure') {
                throw new Error('native fixture failure');
            }
            nativeSend(data);
        };
        if (scenario === 'later-throw') {
            const encode = this.socket.encode.bind(this.socket);
            this.socket.encode = (value) => {
                const encoded = encode(value);
                let reads = 0;
                return {
                    get text() {
                        reads += 1;
                        if (reads > 1) {
                            throw new Error('after native return');
                        }
                        return encoded.text;
                    }
                };
            };
        }
        if (scenario === 'closed') {
            const encode = this.socket.encode.bind(this.socket);
            this.socket.encode = (value) => {
                this.origin.close();
                return encode(value);
            };
        }
    }

    private async installPublication(scenario: ReceiptOwnerScenario): Promise<void> {
        this.socket.connections.delete('origin');
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: this.service,
            channel: 'receipt-test',
            publisherId: 'publisher-1',
            receiptObserver: this.observe,
            bridge: {
                subscribe: async () => {},
                publish: async (_channel, message) => {
                    this.effects.publications += 1;
                    if (scenario === 'publish-throw') {
                        throw new Error('publisher fixture failure');
                    }
                    if (scenario === 'direct-failure' && JSON.stringify(message.key) === this.effects.receiptKey) {
                        this.socket.addConnection(new ConnectionContext({ id: 'origin', socket: this.origin }));
                    }
                }
            }
        });
    }

    private assertTransportEffects(scenario: ReceiptOwnerScenario): void {
        if (scenario === 'native-return') {
            assert.ok(this.origin.sent.some((text) => text.includes(this.effects.receiptControlMsgId)));
        }
        if (scenario === 'native-throw' || scenario === 'direct-failure') {
            assert.ok(this.effects.nativeCalls > 0);
        }
        if (scenario === 'closed' || scenario === 'publish-return' || scenario === 'publish-throw') {
            assert.equal(this.effects.nativeCalls, 0);
        }
        if (scenario.startsWith('publish') || scenario === 'direct-failure') {
            assert.ok(this.effects.publications > 0);
        }
    }
}

function installReceiptConflict(
    store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>,
    effects: { conflicted: boolean; receiptControlMsgId: string; receiptKey: string; }
): void {
    const commit = store.commitBundle.bind(store);
    const commitWithConflict: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>['commitBundle'] = async (bundle) => {
        const message: ALMessage | undefined = bundle.canonicalEntry && JSON.parse(bundle.canonicalEntry.resource);
        const control = message && decodeALControlMessage(message).right;
        if (!effects.conflicted && message && control?.type === 'receipt' && control.payload.phase === 'complete') {
            effects.conflicted = true;
            effects.receiptControlMsgId = message.id.msgId;
            effects.receiptKey = JSON.stringify(bundle.canonicalEntry?.key);
            assert.equal(await commit(await commitCompetitor(store, message)), 'committed');
            const result = await commit(bundle);
            assert.equal(result, 'conflict');
            return result;
        }
        return await commit(bundle);
    };
    assert.equal(Reflect.set(store, 'commitBundle', commitWithConflict), true);
}

async function generateCompleteReceipt(service: WsQueueBoxServerService): Promise<void> {
    assert.equal((await service.acceptIncomingMessage(subject(), 'origin')).right?.kind, 'admitted');
    const ack = newALAckControlMessage(
        { v: 3, msgId: 'ack-1', senderId: 'recipient', ts: Date.now() },
        {
            ackedMsgId: 'subject',
            originPeerId: 'origin',
            fromPeerId: 'recipient',
            toPeerId: 'origin',
            logicalRecipientPeerId: 'recipient',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
    assert.equal((await service.acceptIncomingMessage(ack, 'recipient')).right?.kind, 'control');
}

async function drainReceipt(engine: InboxOutboxEngine, finished: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        engine.wake();
        await engine.executeOnce();
        if (finished()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('The actual generated complete receipt did not reach its transport owner');
}

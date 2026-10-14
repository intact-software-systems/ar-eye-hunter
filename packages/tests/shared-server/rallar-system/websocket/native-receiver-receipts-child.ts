import assert from 'node:assert/strict';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { createRallarGameEnvelope } from '@shared-web/game/envelopes.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALAckPayload, decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import {
    createDefaultWsQueueBoxClientService,
    type WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { stopNativeReceiptScenario } from '../../../../../apps/api-v1/test/db/native-admission-test-cleanup.ts';
import {
    createNativeSessionTestFixture,
    issueNativeWebSocketTicket,
    issueSameUserSessions,
    readAdmittedSnapshot,
    writeNativeGroupCreate,
    writeNativeGroupJoin,
    writeNativeGroupPresence,
    type NativeGroupRequestResult,
    type NativeGroupSessionFlow,
    type NativeSessionTestFixture
} from '../../../../../apps/api-v1/test/db/native-session-test-fixture.ts';

const EVENT_TOPIC = 'room.native-receipt-game';
const EVENT_TYPE = `${EVENT_TOPIC}.event.v1`;

interface NativeReceiptPeer {
    readonly session: IssuedAuthSession;
    readonly socket: JsonWebSocketClient;
    readonly service: WsQueueBoxClientService;
    readonly engine: InboxOutboxEngine;
}

interface NativeReceiptPeerConstruction {
    readonly fixture: NativeSessionTestFixture;
    readonly baseUrl: string;
    readonly session: IssuedAuthSession;
    readonly index: number;
    readonly heldAck: NativeSubjectAckHold;
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly originPeerId: string;
}

class NativeSubjectAckHold {
    readonly reached = Promise.withResolvers<ALMessage>();
    readonly settled = Promise.withResolvers<Extract<ALDeliverySettlement, { kind: 'attempt-settled'; }>>();
    private subjectMsgId: string | undefined;
    private heldControlMsgId: string | undefined;
    private holding = true;
    readonly receiverPeerId: string;

    constructor(receiverPeerId: string) {
        this.receiverPeerId = receiverPeerId;
    }

    setSubject(msgId: string): void {
        this.subjectMsgId = msgId;
    }

    release(): void {
        this.holding = false;
    }

    readSubmissionIneligibility(message: ALMessage): string | undefined {
        if (
            !this.holding || message.id.senderId !== this.receiverPeerId ||
            message.payload.typeId !== AL_CONTROL_ACK_TYPE_ID
        ) {
            return undefined;
        }
        const ack = decodeALAckPayload(JSON.parse(message.payload.resource));
        if (ack.ackedMsgId !== this.subjectMsgId || ack.logicalRecipientPeerId !== this.receiverPeerId) {
            return undefined;
        }
        this.heldControlMsgId = message.id.msgId;
        this.reached.resolve(message);
        return 'Subject receiver ACK submission held';
    }

    recordSettlement(settlement: ALDeliverySettlement): void {
        if (
            settlement.msgId === this.heldControlMsgId && settlement.kind === 'attempt-settled' &&
            settlement.outcome === 'not-ready'
        ) {
            this.settled.resolve(settlement);
        }
    }
}

Deno.test('fourteen automatic receiver ACKs cross native API sockets and complete the exact origin receipt after release', async () => {
    const fixture = await createNativeSessionTestFixture();
    const peers: NativeReceiptPeer[] = [];
    const registry = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 512,
        cancel: () => {}
    });
    let primaryFailure: Error | undefined;

    try {
        const baseUrl = await fixture.start();
        const sessions = await issueSameUserSessions(fixture.runtime, fixture.sessionTtlMs);
        assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 15);
        const [originSession, ...receiverSessions] = sessions;
        assert.ok(originSession && receiverSessions.length === 14);
        const expectedAudience = Object.freeze(receiverSessions.map((session) => session.sessionId).sort());
        const heldAck = new NativeSubjectAckHold(receiverSessions[13].sessionId);
        const groupRef: GroupRef = {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: `native-receipts-${crypto.randomUUID()}`
        };
        const connected = await Promise.allSettled(sessions.map(async (session, index) => {
            const peer = await startNativeReceiptPeer({
                fixture,
                baseUrl,
                session,
                index,
                heldAck,
                registry,
                originPeerId: originSession.sessionId
            });
            peers.push(peer);
            await peer.socket.connect({ signal: AbortSignal.timeout(45_000) });
            return peer;
        }));
        for (const result of connected) {
            if (result.status === 'rejected') {
                throw result.reason;
            }
        }
        const origin = peers.find((peer) => peer.session.sessionId === originSession.sessionId);
        assert.ok(origin);
        const setup = { fixture, baseUrl, groupRef };
        const originFlow = getNativeReceiptRoomFlow(origin, setup, 0);
        assertNativeReceiptRoomResponse(await writeNativeGroupCreate(originFlow));
        assertNativeReceiptRoomResponse(await writeNativeGroupJoin(originFlow));
        const presenceConnections = await Promise.allSettled(
            peers.map(async (peer, index) => await connectNativeReceiptPeer(peer, setup, index))
        );
        for (const result of presenceConnections) {
            if (result.status === 'rejected') {
                throw result.reason;
            }
        }
        const admitted = await readAdmittedSnapshot(fixture.runtime);
        assert.deepEqual(
            admitted.activeSessions.map((session) => session.sessionId).sort(),
            sessions.map((session) => session.sessionId).sort()
        );
        const presence = await fixture.runtime.groupsRepository.listPresenceSessions(groupRef);
        assert.deepEqual(
            presence.map((session) => session.sessionId).sort(),
            sessions.map((session) => session.sessionId).sort()
        );
        const subject = createNativeReceiptEvent(originSession.sessionId, groupRef);
        heldAck.setSubject(subject.id.msgId);
        const arrivals = observeNativeReceiptArrivals(peers, expectedAudience);
        const receipts = observeNativeOriginReceipts(origin.socket, subject.id.msgId);
        const handle = registry.open(subject, 'ws');
        const expiresAtMs = subject.constraints?.expiresAtMs;
        assert.ok(expiresAtMs);
        const admittedSubject = await origin.service.enqueueOutboxIfAbsent(subject);
        assert.equal(admittedSubject.verdict.kind, 'admitted');
        await waitBeforeSubjectDeadline(
            Promise.all([arrivals.completed.promise, heldAck.settled.promise, receipts.admitted.promise]),
            expiresAtMs
        );
        assertNativeReceiptArrivals(arrivals, subject, expectedAudience);
        const held = await heldAck.reached.promise;
        assertHeldNativeSubjectAck(held, subject, heldAck.receiverPeerId);
        assert.equal((await heldAck.settled.promise).submissionAttempted, false);
        assert.equal(receipts.values.some((receipt) => receipt.phase === 'complete'), false);
        assert.notEqual(handle.lifecycle().state, 'acknowledged');
        assert.ok(Date.now() < expiresAtMs);

        heldAck.release();
        const [complete, outcome] = await waitBeforeSubjectDeadline(
            Promise.all([
                receipts.completed.promise,
                handle.wait({ until: ['acknowledged'] })
            ]),
            expiresAtMs
        );
        assert.equal(complete.msgId, subject.id.msgId);
        assert.equal(complete.originPeerId, originSession.sessionId);
        assert.equal(complete.phase, 'complete');
        assert.deepEqual([...complete.expectedRecipientPeerIds].sort(), expectedAudience);
        assert.deepEqual([...complete.confirmedRecipientPeerIds].sort(), expectedAudience);
        assert.ok(!complete.expectedRecipientPeerIds.includes(originSession.sessionId));
        assert.equal(outcome.status, 'settled');
        assert.equal(outcome.lifecycle.state, 'acknowledged');
        assert.equal(outcome.lifecycle.receiptAlgo, 'receiver');
        assert.deepEqual([...(outcome.lifecycle.evidence.expectedRecipientPeerIds ?? [])].sort(), expectedAudience);
        assert.deepEqual([...(outcome.lifecycle.evidence.confirmedRecipientPeerIds ?? [])].sort(), expectedAudience);
        assert.deepEqual(outcome.lifecycle.evidence.unconfirmedRecipientPeerIds, []);
        assertNativeReceiptArrivals(arrivals, subject, expectedAudience);
        assert.ok(Date.now() < expiresAtMs);
        console.log(JSON.stringify({
            nativeReceiverArrivals: arrivals.observations.length,
            receiptExpected: complete.expectedRecipientPeerIds.length,
            receiptConfirmed: complete.confirmedRecipientPeerIds.length,
            originState: outcome.lifecycle.state,
            subjectElapsedMs: Date.now() - subject.id.ts
        }));
    }
    catch (error) {
        primaryFailure = error instanceof Error ? error : new Error(String(error));
    }
    finally {
        await stopNativeReceiptScenario({
            releaseDeliveryRegistry: () => {
                registry.releaseAll();
            },
            stopPeers: peers.map((peer) => () => stopNativeReceiptPeer(peer)),
            stopRuntime: (closures, failure) => fixture.stop(closures, failure),
            primaryFailure,
            reportSecondaryFailures: (failure) => {
                console.error('Native receipt secondary cleanup failures', failure);
            }
        });
    }
});

async function startNativeReceiptPeer(construction: NativeReceiptPeerConstruction): Promise<NativeReceiptPeer> {
    const ticket = await issueNativeWebSocketTicket(construction.baseUrl, construction.session, construction.index);
    const url = new URL(`/api/ws/${construction.session.sessionId}`, construction.baseUrl);
    url.protocol = 'ws:';
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('applicationId', 'rallar-server');
    url.searchParams.set('workspaceId', 'default');
    const socket = new JsonWebSocketClient(url.toString(), createPassThroughTransportFaultPort());
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxClientService({
        socket,
        sessionId: construction.session.sessionId,
        serverPeerId: construction.fixture.runtime.wsQBoxServerService.name,
        outbox: new InMemoryQueueBox(),
        queueEngine: engine,
        readSubmissionIneligibility: (message) => construction.heldAck.readSubmissionIneligibility(message),
        outboundSettlements: (settlement) => {
            construction.heldAck.recordSettlement(settlement);
            if (construction.session.sessionId === construction.originPeerId) {
                construction.registry.record(settlement);
            }
        }
    });
    service.enableDefaultCallbacks();
    engine.start();
    return { session: construction.session, socket, service, engine };
}

interface NativeReceiptRoomSetup {
    readonly fixture: NativeSessionTestFixture;
    readonly baseUrl: string;
    readonly groupRef: GroupRef;
}

async function connectNativeReceiptPeer(
    peer: NativeReceiptPeer,
    setup: NativeReceiptRoomSetup,
    index: number
): Promise<void> {
    const flow = getNativeReceiptRoomFlow(peer, setup, index);
    assertNativeReceiptRoomResponse(await writeNativeGroupPresence(flow));
    const presence = await setup.fixture.runtime.groupsRepository.findPresenceSession({
        ...setup.groupRef,
        sessionId: peer.session.sessionId
    });
    assert.ok(presence);
    assert.equal(presence.generationId, flow.generationId);
    assert.equal(presence.status, 'active');
}

function getNativeReceiptRoomFlow(
    peer: NativeReceiptPeer,
    setup: NativeReceiptRoomSetup,
    index: number
): NativeGroupSessionFlow {
    const connection = setup.fixture.runtime.wsQBoxServerService.socket.connections.get(peer.session.sessionId);
    assert.ok(connection?.isOpen);
    return {
        baseUrl: setup.baseUrl,
        session: peer.session,
        groupRef: setup.groupRef,
        generationId: connection.generationId,
        index
    };
}

function assertNativeReceiptRoomResponse(request: NativeGroupRequestResult): void {
    assert.equal(
        request.status,
        request.command.operation === 'create-group' ? 201 : 200,
        `${request.command.request.requestId}: ${JSON.stringify(request.body)}`
    );
    validateAuthoritativeGroupSnapshot(request.body, request.command.scope);
}

function createNativeReceiptEvent(originPeerId: string, roomRef: GroupRef): ALMessage {
    const envelope = createRallarGameEnvelope({
        protocol: 'native-receipt-game.v1',
        kind: 'event',
        roomId: roomRef.groupId,
        senderId: originPeerId,
        seq: 1,
        directorEpoch: 1,
        payload: { kind: 'match-started', roomRef }
    });
    return newALMulticastMessage(
        originPeerId,
        { topicId: EVENT_TOPIC, resourceId: 'match-started', contextId: roomRef.groupId },
        roomRef,
        EVENT_TYPE,
        envelope,
        {
            ack: AL_CHANNEL_SEND_DEFAULTS.notification.ack,
            reliability: AL_CHANNEL_SEND_DEFAULTS.notification.reliability,
            ttlMs: AL_CHANNEL_SEND_DEFAULTS.notification.ttlMs
        }
    );
}

interface NativeReceiptArrival {
    readonly receiverPeerId: string;
    readonly message: ALMessage;
}

interface NativeReceiptArrivals {
    readonly observations: NativeReceiptArrival[];
    readonly completed: PromiseWithResolvers<void>;
}

function observeNativeReceiptArrivals(
    peers: readonly NativeReceiptPeer[],
    expectedAudience: readonly string[]
): NativeReceiptArrivals {
    const arrivals: NativeReceiptArrivals = { observations: [], completed: Promise.withResolvers<void>() };
    for (const peer of peers) {
        peer.service.onInboxMessageDo(EVENT_TYPE, {
            onMessage: (message) => {
                arrivals.observations.push({ receiverPeerId: peer.session.sessionId, message });
                if (arrivals.observations.length >= expectedAudience.length) {
                    arrivals.completed.resolve();
                }
                return Promise.resolve();
            }
        });
    }
    return arrivals;
}

function assertNativeReceiptArrivals(
    arrivals: NativeReceiptArrivals,
    subject: ALMessage,
    expectedAudience: readonly string[]
): void {
    assert.deepEqual(arrivals.observations.map((arrival) => arrival.receiverPeerId).sort(), expectedAudience);
    for (const arrival of arrivals.observations) {
        assert.equal(arrival.message.id.msgId, subject.id.msgId);
        assert.equal(arrival.message.id.senderId, subject.id.senderId);
        assert.ok(arrival.message.targets?.mode === 'multicast' && subject.targets?.mode === 'multicast');
        assert.ok(isSameGroupRef(arrival.message.targets.groupRef, subject.targets.groupRef));
        assert.equal(arrival.message.payload.resource, subject.payload.resource);
    }
}

interface NativeOriginReceipts {
    readonly values: ALReceiptPayload[];
    readonly admitted: PromiseWithResolvers<ALReceiptPayload>;
    readonly completed: PromiseWithResolvers<ALReceiptPayload>;
}

function observeNativeOriginReceipts(socket: JsonWebSocketClient, subjectMsgId: string): NativeOriginReceipts {
    const receipts: NativeOriginReceipts = {
        values: [],
        admitted: Promise.withResolvers<ALReceiptPayload>(),
        completed: Promise.withResolvers<ALReceiptPayload>()
    };
    socket.onWebSocketMessageDo('native-receipt-observer', {
        onMessage: (value) => {
            const message = decodeALMessageValue(value).right;
            if (message?.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID) {
                const receipt = decodeALReceiptPayload(JSON.parse(message.payload.resource));
                if (receipt.msgId === subjectMsgId) {
                    receipts.values.push(receipt);
                    if (receipt.phase === 'admitted') {
                        receipts.admitted.resolve(receipt);
                    }
                    if (receipt.phase === 'complete') {
                        receipts.completed.resolve(receipt);
                    }
                }
            }
            return Promise.resolve();
        }
    });
    return receipts;
}

function assertHeldNativeSubjectAck(held: ALMessage, subject: ALMessage, receiverPeerId: string): void {
    assert.equal(held.id.senderId, receiverPeerId);
    const ack = decodeALAckPayload(JSON.parse(held.payload.resource));
    assert.equal(ack.ackedMsgId, subject.id.msgId);
    assert.equal(ack.fromPeerId, receiverPeerId);
    assert.equal(ack.logicalRecipientPeerId, receiverPeerId);
    assert.equal(ack.toPeerId, subject.id.senderId);
    assert.equal(ack.originPeerId, subject.id.senderId);
    assert.equal(ack.carrier, 'ws');
    assert.equal(ack.status, 'delivered');
}

async function waitBeforeSubjectDeadline<T>(observed: Promise<T>, expiresAtMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            observed,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error('Native receiver receipt did not complete within the original 30000 ms subject lifetime'));
                }, Math.max(0, expiresAtMs - Date.now()));
            })
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

async function stopNativeReceiptPeer(peer: NativeReceiptPeer): Promise<void> {
    const socket = peer.socket.ws;
    const closed = socket === undefined || socket.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            socket.addEventListener('close', () => {
                resolve();
            }, { once: true });
        });
    const failures: Error[] = [];
    try {
        await peer.service.close();
    }
    catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
        await peer.engine.stop();
    }
    catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    await closed;
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Native receipt client cleanup failed');
    }
}

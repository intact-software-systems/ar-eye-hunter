import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { installRelayedAckNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice-subscriber.ts';
import { toRelayedAckNotice } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    newALAckControlMessage,
    type ALAckPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { WsQueueBoxServerAckRelay } from '@shared/services/ws-queue-box-server/ws-queue-box-server-ack-relay.ts';
import type { WsServerInboundAuthorizer } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { WsQueueBoxServerControlDelivery } from '@shared/services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts';
import { WsQueueBoxServerInboundAuthority } from '@shared/services/ws-queue-box-server/ws-queue-box-server-inbound-authority.ts';
import { WsQueueBoxServerReceiptAggregation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts';
import type {
    WsQueueBoxServerReceiptObservation,
    WsQueueBoxServerReceiptObserver
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

interface ObservedServerOptions {
    readonly inboundStores?: ALInboundRuntimeStores;
    readonly outboundStores?: WsQueueBoxServerService.Input['outboundStores'];
    readonly queueEngine?: InboxOutboxEngine;
    readonly installRoomAuthorizer?: boolean;
    readonly readAuthenticatedConnectionScope?: WsQueueBoxServerService.Input['readAuthenticatedConnectionScope'];
    readonly authorizer?: WsServerInboundAuthorizer;
}

interface AckAuthorizerGate {
    readonly authorizer: WsServerInboundAuthorizer;
    readonly entered: Promise<void>;
    readonly release: () => void;
}

interface ReceiptAggregationFixtureEffects {
    readonly clock?: ReceiptClock;
    readonly acceptServerReceipt?: WsQueueBoxServerReceiptAggregation.Dependencies['acceptServerReceipt'];
}

interface ObservedReceiptAggregation {
    readonly aggregation: WsQueueBoxServerReceiptAggregation;
    readonly clock: ReceiptClock;
}

interface ReceiptClock {
    value: number;
}

interface ReceiptCommitOutcome {
    readonly phase: ALReceiptPayload['phase'];
    readonly expectedVersion: number | undefined;
    readonly status: 'committed' | 'conflict' | 'expired';
}

interface ReceiptSettlementEffect {
    readonly kind: string;
    readonly clock: number;
    readonly confirmed: readonly string[];
}

async function createObservedServer(
    observe: WsQueueBoxServerReceiptObserver | undefined,
    expiresAtEpochMs = Number.MAX_SAFE_INTEGER,
    options: ObservedServerOptions = {}
) {
    const socket = new JsonWebSocketServer();
    for (const id of ['origin', 'recipient']) {
        const native = new SimulatedWebSocket(`ws://${id}`);
        await native.open();
        socket.addConnection(new ConnectionContext({ id, socket: native }));
    }
    const engine = options.queueEngine ?? new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox: new InMemoryQueueBox(),
        socket,
        name: 'server',
        queueEngine: engine,
        inboundStores: options.inboundStores,
        outboundStores: options.outboundStores,
        readAuthenticatedConnectionScope: options.readAuthenticatedConnectionScope ?? (() => ({ scope: SCOPE, expiresAtEpochMs })),
        targetResolver: { resolveBroadcastRecipients: () => [{ peerId: 'recipient', connectionId: 'recipient' }] },
        receiptObserver: observe
    });
    if (options.installRoomAuthorizer !== false) {
        service.authorizeInboundMessagesWith(
            options.authorizer ?? {
                authorize: async (message) =>
                    isRoomScopedALMessage(message)
                        ? ({ authorized: true, roomAudience: { recipientPeerIds: ['recipient'], snapshotVersion: 7 } })
                        : ({ authorized: true }),
                sendNacks: false
            }
        );
    }
    onTestFinished(async () => {
        const cleanup = await Promise.allSettled([service.dispose(), engine.stop()]);
        const failure = cleanup.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw toError(failure.reason);
        }
    });
    return service;
}

function createAckAuthorizerGate(controlMsgId: string): AckAuthorizerGate {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    return {
        entered: entered.promise,
        release: () => release.resolve(),
        authorizer: {
            sendNacks: false,
            authorize: async (message) => {
                if (message.id.msgId === controlMsgId) {
                    entered.resolve();
                    await release.promise;
                }
                return isRoomScopedALMessage(message)
                    ? { authorized: true, roomAudience: { recipientPeerIds: ['recipient'], snapshotVersion: 7 } }
                    : { authorized: true };
            }
        }
    };
}

async function replaceRecipientConnection(socket: JsonWebSocketServer): Promise<void> {
    const native = new SimulatedWebSocket('ws://replacement');
    await native.open();
    socket.addConnection(new ConnectionContext({ id: 'recipient', socket: native }));
}

async function readCompleteReceipts(service: WsQueueBoxServerService): Promise<readonly ALReceiptPayload[]> {
    const entries = await Promise.all((await service.outbox.getAllKeys()).map((key) => service.outbox.getItem(key)));
    return entries
        .flatMap((entry) => entry?.typeId === EnqueuedType.WS_OUTBOX ? [decodePersistedALMessage(entry.resource)] : [])
        .flatMap((message) => {
            const control = decodeALControlMessage(message).right;
            return control?.type === 'receipt' && control.payload.phase === 'complete' ? [control.payload] : [];
        });
}

function readSentReceipts(service: WsQueueBoxServerService): readonly ALMessage[] {
    const socket = service.socket.connections.get('origin')?.socket;
    if (!(socket instanceof SimulatedWebSocket)) {
        throw new Error('Expected the observed origin socket');
    }
    return socket.sent.map(decodePersistedALMessage).filter((message) => decodeALControlMessage(message).right?.type === 'receipt');
}

async function waitForReceiptCompletion(
    service: WsQueueBoxServerService,
    engine: InboxOutboxEngine,
    phases: readonly ALReceiptPayload['phase'][]
): Promise<void> {
    await expect.poll(async () => {
        await engine.executeOnce();
        return readSentReceipts(service).map((message) => {
            const control = decodeALControlMessage(message).right;
            return control?.type === 'receipt' ? control.payload.phase : undefined;
        });
    }).toEqual(phases);
    await expect.poll(async () => {
        const entries = await Promise.all((await service.outbox.getAllKeys()).map((key) => service.outbox.getItem(key)));
        const work = entries.filter((entry) => entry?.typeId === EnqueuedType.WS_OUTBOX || entry?.key.topicId === 'AL_OUTBOUND');
        return work.length > 0 && work.every((entry) => entry?.status === EntityStatus.COMPLETED);
    }).toBe(true);
}

function createObservedInboundStores(): ALInboundRuntimeStores {
    const inbound = createInMemoryALAdmissionState();
    return {
        admissionStore: createALInboundAdmissionStore({
            namespace: 'receipt-observation',
            nowMs: Date.now,
            backend: new InMemoryAdmissionBackend(inbound, Date.now),
            orderingTrackTtlMs: 300000,
            supersedenceTrackTtlMs: 300000,
            retention: normalizeALRuntimeStoreRetention(),
            maxOrderingTracks: undefined,
            maxDeliveredMarkers: undefined
        }),
        workQueue: inbound.workQueue
    };
}

function createRoomSubjectMessage(): ALMessage {
    return {
        id: { v: 4, msgId: 'subject', senderId: 'origin', ts: Date.now(), traceId: 'trace-ws-queue-box-server-receipt-observation' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: 'room' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { ...SCOPE, groupId: 'room' } },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function createReceiverAcknowledgement(senderId = 'recipient'): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: 'ack-1', senderId, ts: Date.now() - 1, traceId: 'trace-ws-queue-box-server-receipt-observation' },
        {
            ackedMsgId: 'subject',
            originPeerId: 'origin',
            fromPeerId: senderId,
            toPeerId: 'origin',
            logicalRecipientPeerId: senderId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now() - 1
        }
    );
}

function createReceiverAcknowledgementPayload(): ALAckPayload {
    const control = decodeALControlMessage(createReceiverAcknowledgement()).right;
    if (control?.type !== 'ack') {
        throw new Error('test ACK malformed');
    }
    return control.payload;
}

describe('private upstream receipt observation', () => {
    it('retains real authenticated socket, complete count and distinct outbox outcomes', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const inboundStores = createObservedInboundStores();
        const { admissionStore } = inboundStores;
        const engine = new InboxOutboxEngine();
        const service = await createObservedServer((event) => events.push(event), undefined, { inboundStores, queueEngine: engine });
        const message = createRoomSubjectMessage();
        const admission = await service.acceptIncomingMessage(message, 'origin');
        expect(admission.left).toBeUndefined();
        expect(admission.right?.kind).toBe('admitted');
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'receipt-outbox',
            receipt: expect.objectContaining({ phase: 'admitted', msgId: 'subject', expectedRecipientPeerIds: ['recipient'] }),
            verdict: expect.objectContaining({ kind: 'admitted', durable: true })
        }));
        // This case asserts uncontended admission; the admitted receipt's dequeue also writes the sender fence.
        await waitForReceiptCompletion(service, engine, ['admitted']);
        const accepted = await service.acceptIncomingMessage(createReceiverAcknowledgement(), 'recipient');
        expect(accepted.left).toBeUndefined();
        expect(accepted.right?.kind).toBe('control');
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'socket-decision',
                connectionId: 'recipient',
                fromPeerId: 'recipient',
                scopeDisposition: 'authorized',
                outcome: 'control'
            }),
            expect.objectContaining({
                kind: 'ack-count',
                controlMsgId: 'ack-1',
                source: 'local',
                outcome: 'complete',
                before: expect.objectContaining({ expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: [] }),
                after: expect.objectContaining({ confirmedRecipientPeerIds: ['recipient'] })
            }),
            expect.objectContaining({
                kind: 'receipt-outbox',
                receipt: expect.objectContaining({ phase: 'complete', msgId: 'subject' }),
                verdict: expect.objectContaining({ kind: 'admitted', durable: true })
            })
        ]));
        const persisted = await admissionStore.readDeliverySurface({ senderId: 'origin', msgId: 'subject' }, Date.now());
        expect(persisted?.msg).toEqual(message);
        expect(persisted?.source).toMatchObject({ kind: 'ws-client', peerId: 'origin', authenticatedScope: SCOPE });
        expect(await admissionStore.readIngressAudience('subject', 'origin')).toEqual(['recipient']);
        console.log(
            'Ordinary business admission effects:',
            JSON.stringify({
                admission: admission.right?.kind,
                persistedMsgId: persisted?.msg.id.msgId,
                originPeerId: persisted?.source.kind === 'ws-client' ? persisted.source.peerId : undefined,
                recipientPeerIds: await admissionStore.readIngressAudience('subject', 'origin'),
                ackAcceptance: accepted.right?.kind,
                completeReceipt: events.some((event) => event.kind === 'receipt-outbox' && event.receipt.phase === 'complete')
            })
        );
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'business-socket-decision',
            serverPeerId: 'server',
            msgId: 'subject',
            senderId: 'origin',
            typeId: 'message.v1',
            topicId: 'room.notification',
            connectionId: 'origin',
            fromPeerId: 'origin',
            authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' },
            scopeDisposition: 'authorized',
            outcome: 'admitted'
        }));
        expect(events.filter((event) => event.kind === 'business-socket-decision')).toHaveLength(1);
        expect(events.filter((event) => event.kind === 'ack-rejection')).toEqual([]);
    });

    it('retains a complete receipt after a real sender conflict and delivers its committed work exactly once', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const engine = new InboxOutboxEngine();
        const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
        const inboundStores = createObservedInboundStores();
        const service = await createObservedServer((event) => events.push(event), undefined, { inboundStores, outboundStores, queueEngine: engine });
        const dequeueEntered = Promise.withResolvers<void>();
        const releaseDequeue = Promise.withResolvers<void>();
        const dequeueFinished = Promise.withResolvers<void>();
        const commits: ReceiptCommitOutcome[] = [];
        const commitBundle = outboundStores.admissionStore.commitBundle.bind(outboundStores.admissionStore);
        const commitSpy = vi.spyOn(outboundStores.admissionStore, 'commitBundle').mockImplementation(async (bundle, observation) => {
            const control = bundle.canonicalEntry && decodeALControlMessage(decodePersistedALMessage(bundle.canonicalEntry.resource)).right;
            const phase = control?.type === 'receipt' ? control.payload.phase : undefined;
            const admittedDequeue = phase === 'admitted' && bundle.durableEffects.some((effect) => effect.payload.kind === 'send-prepared');
            if (admittedDequeue) {
                dequeueEntered.resolve();
                await releaseDequeue.promise;
            }
            if (phase === 'complete' && bundle.pendingAdmission === undefined && bundle.durableEffects.length === 0) {
                releaseDequeue.resolve();
                await dequeueFinished.promise;
            }
            const status = await commitBundle(bundle, observation);
            if (phase !== undefined) {
                commits.push({ phase, expectedVersion: bundle.expectedVersion, status });
            }
            if (admittedDequeue) {
                dequeueFinished.resolve();
            }
            return status;
        });
        const closeReceiptContender = async () => {
            releaseDequeue.resolve();
            dequeueFinished.resolve();
            try {
                await service.dispose();
            }
            finally {
                commitSpy.mockRestore();
            }
        };
        onTestFinished(closeReceiptContender);
        try {
            const message = createRoomSubjectMessage();
            expect((await service.acceptIncomingMessage(message, 'origin')).right?.kind).toBe('admitted');
            await dequeueEntered.promise;
            expect((await service.acceptIncomingMessage(createReceiverAcknowledgement(), 'recipient')).right?.kind).toBe('control');
            expect(commits).toEqual(expect.arrayContaining([
                { phase: 'admitted', expectedVersion: undefined, status: 'committed' },
                { phase: 'admitted', expectedVersion: 1, status: 'committed' },
                { phase: 'complete', expectedVersion: 1, status: 'conflict' }
            ]));
            const pending = events.find((event) => event.kind === 'receipt-outbox' && event.receipt.phase === 'complete');
            expect(pending).toMatchObject({ kind: 'receipt-outbox', verdict: { kind: 'pending' }, entryCount: 1, trackedReceiptAlgo: 'none' });
            if (pending?.kind !== 'receipt-outbox') {
                throw new Error('Expected the actual retained receipt');
            }
            await waitForReceiptCompletion(service, engine, ['admitted', 'complete']);
            const sent = readSentReceipts(service);
            expect(sent.map((receipt) => receipt.id.msgId)).toEqual([
                expect.any(String),
                pending.receiptControlMsgId
            ]);
            expect(events).toContainEqual(expect.objectContaining({
                kind: 'receipt-work',
                receiptControlMsgId: pending.receiptControlMsgId,
                effectKind: 'admit-message',
                admissionVerdict: 'admitted',
                admissionCommitted: true,
                callbackOutcome: 'completed'
            }));
            const persisted = await outboundStores.admissionStore.readSentMessage(pending.receiptControlMsgId);
            expect(persisted?.msg).toEqual(sent[1]);
            expect(decodeALControlMessage(persisted!.msg).right).toMatchObject({
                type: 'receipt',
                payload: {
                    msgId: 'subject',
                    originPeerId: 'origin',
                    phase: 'complete',
                    expectedRecipientPeerIds: ['recipient'],
                    confirmedRecipientPeerIds: ['recipient'],
                    snapshotVersion: 7
                }
            });
            const admitted = await inboundStores.admissionStore.readDeliverySurface({ senderId: 'origin', msgId: 'subject' }, Date.now());
            expect(admitted?.msg).toEqual(message);
            expect(admitted?.source).toMatchObject({ kind: 'ws-client', peerId: 'origin', authenticatedScope: SCOPE });
            expect(await inboundStores.admissionStore.readIngressAudience('subject', 'origin')).toEqual(['recipient']);
            await engine.executeOnce();
            expect(readSentReceipts(service)).toEqual(sent);
            expect(events.filter((event) => event.kind === 'receipt-outbox' && event.receipt.phase === 'complete')).toEqual([pending]);
        }
        finally {
            await closeReceiptContender();
        }
    });

    it('preserves the actual resolved scope when a room submission has no installed authorizer', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const inboundStores = createObservedInboundStores();
        let scopeReads = 0;
        const service = await createObservedServer((event) => events.push(event), undefined, {
            inboundStores,
            installRoomAuthorizer: false,
            readAuthenticatedConnectionScope: () => {
                scopeReads += 1;
                return { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER };
            }
        });
        const result = await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin');
        expect(result.left?.code).toBe('unsupported');
        expect(result.right).toBeUndefined();
        expect(scopeReads).toBe(1);
        const businessScopeReads = scopeReads;
        const persisted = await inboundStores.admissionStore.readDeliverySurface({ senderId: 'origin', msgId: 'subject' }, Date.now());
        const workKeys = await inboundStores.workQueue.getAllKeys();
        expect(persisted).toBeUndefined();
        expect(workKeys).toEqual([]);
        expect(events.some((event) => event.kind === 'ack-count' || event.kind === 'receipt-outbox')).toBe(false);
        for (const connection of service.socket.connections.values()) {
            if (!(connection.socket instanceof SimulatedWebSocket)) {
                throw new Error('Observed server has an unexpected native socket fixture');
            }
            expect(connection.socket.sent).toEqual([]);
        }
        const canonicalAck = createReceiverAcknowledgement();
        const canonicalAckIsRoomScoped = isRoomScopedALMessage(canonicalAck);
        expect(canonicalAckIsRoomScoped).toBe(false);
        expect(decodeALControlMessage(canonicalAck).right?.type).toBe('ack');
        expect((await service.acceptIncomingMessage(canonicalAck, 'recipient')).left?.code).toBe('unauthorized');
        expect(events).toContainEqual({
            kind: 'ack-rejection',
            serverPeerId: 'server',
            controlMsgId: 'ack-1',
            controlSenderId: 'recipient',
            controlCreatedAtEpochMs: canonicalAck.id.ts,
            rejectionCode: 'unauthorized',
            owner: 'receipt-aggregation',
            stage: 'ingress-protocol',
            failedGuards: ['aggregate-absent'],
            validationAtEpochMs: expect.any(Number),
            deadlineAtMs: undefined
        });
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'socket-decision',
            fromPeerId: 'recipient',
            authenticatedScope: SCOPE,
            scopeDisposition: 'authorized',
            outcome: 'rejected',
            rejectionCode: 'unauthorized'
        }));
        console.log(
            'Missing room authorizer effects:',
            JSON.stringify({
                rejection: result.left?.code,
                businessScopeReads,
                persistedSubject: persisted !== undefined,
                durableWorkRows: workKeys.length,
                canonicalAckIsRoomScoped
            })
        );
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'business-socket-decision',
            serverPeerId: 'server',
            msgId: 'subject',
            senderId: 'origin',
            typeId: 'message.v1',
            topicId: 'room.notification',
            connectionId: 'origin',
            fromPeerId: 'origin',
            authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' },
            scopeDisposition: 'authorized',
            outcome: 'rejected',
            rejectionCode: 'unsupported'
        }));
    });

    it('retains the actual forged socket rejection without inventing a count', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => events.push(event));
        await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin');
        events.length = 0;
        const result = await service.acceptIncomingMessage(createReceiverAcknowledgement('forged'), 'recipient');
        expect(result.left?.code).toBe('unauthorized');
        expect(events).toEqual([
            expect.objectContaining({
                kind: 'socket-decision',
                connectionId: 'recipient',
                fromPeerId: 'recipient',
                scopeDisposition: 'unobserved',
                outcome: 'rejected',
                rejectionCode: 'unauthorized'
            })
        ]);
        events.length = 0;
        const message = createRoomSubjectMessage();
        const forged = { ...message, id: { ...message.id, senderId: 'forged' } };
        expect((await service.acceptIncomingMessage(forged, 'origin')).left?.code).toBe('unauthorized');
        expect(events).toEqual([expect.objectContaining({
            kind: 'business-socket-decision',
            msgId: 'subject',
            senderId: 'forged',
            connectionId: 'origin',
            fromPeerId: 'origin',
            authenticatedScope: undefined,
            scopeDisposition: 'unobserved',
            outcome: 'rejected',
            rejectionCode: 'unauthorized'
        })]);
    });

    it('records the real ordinary duplicate without repeating its admission receipt', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => events.push(event));
        const message = createRoomSubjectMessage();
        expect((await service.acceptIncomingMessage(message, 'origin')).right?.kind).toBe('admitted');
        const receipts = events.filter((event) => event.kind === 'receipt-outbox');
        expect((await service.acceptIncomingMessage(message, 'origin')).right?.kind).toBe('duplicate');
        expect(events.filter((event) => event.kind === 'receipt-outbox')).toEqual(receipts);
        expect(events.filter((event) => event.kind === 'business-socket-decision')).toMatchObject([
            { msgId: 'subject', outcome: 'admitted', scopeDisposition: 'authorized' },
            { msgId: 'subject', outcome: 'duplicate', scopeDisposition: 'authorized' }
        ]);
    });

    it('observes missing connections and disposed ordinary submissions without inventing scope or business facts for controls', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => events.push(event));
        expect((await service.acceptIncomingMessage(null, 'origin')).left?.code).toBe('malformed');
        expect(events).toEqual([]);
        expect((await service.acceptIncomingMessage(createReceiverAcknowledgement(), 'missing')).left?.code).toBe('unauthorized');
        expect(events.every((event) => event.kind !== 'business-socket-decision')).toBe(true);
        events.length = 0;
        expect((await service.acceptIncomingMessage(createRoomSubjectMessage(), 'missing')).left?.code).toBe('unauthorized');
        await service.dispose();
        expect((await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin')).right?.kind).toBe('disposed');
        expect(events).toMatchObject([
            {
                kind: 'business-socket-decision',
                connectionId: 'missing',
                fromPeerId: 'missing',
                authenticatedScope: undefined,
                scopeDisposition: 'unobserved',
                outcome: 'rejected'
            },
            {
                kind: 'business-socket-decision',
                connectionId: 'origin',
                fromPeerId: undefined,
                authenticatedScope: undefined,
                scopeDisposition: 'unobserved',
                outcome: 'disposed'
            }
        ]);
    });
});

describe('terminal ACK rejection observation', () => {
    it.each(['absent', 'throwing', 'mutating'] as const)('preserves missing aggregate refusal and live 1/1 completion with a %s sink', async (sink) => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const mutationResults: boolean[] = [];
        const service = await createObservedServer(
            sink === 'absent' ? undefined : (event) => {
                events.push(event);
                if (event.kind === 'ack-rejection' && sink === 'mutating') {
                    mutationResults.push(Reflect.set(event, 'controlMsgId', 'forged'));
                    mutationResults.push(Reflect.set(event.failedGuards, '0', 'deadline-expired'));
                }
                if (sink === 'throwing') {
                    throw new Error('sink failure');
                }
            }
        );
        expect((await service.acceptIncomingMessage(createReceiverAcknowledgement(), 'recipient')).left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement names no receipt this server aggregates'
        });
        expect(await readCompleteReceipts(service)).toEqual([]);
        const rejected = events.filter((event) => event.kind === 'ack-rejection');
        expect(rejected).toEqual(sink === 'absent' ? [] : [expect.objectContaining({ stage: 'ingress-protocol', failedGuards: ['aggregate-absent'] })]);
        expect((await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin')).right?.kind).toBe('admitted');
        expect((await service.acceptIncomingMessage(createReceiverAcknowledgement(), 'recipient')).right?.kind).toBe('control');
        expect(await readCompleteReceipts(service)).toMatchObject([{
            expectedRecipientPeerIds: ['recipient'],
            confirmedRecipientPeerIds: ['recipient'],
            phase: 'complete'
        }]);
        expect(events.filter((event) => event.kind === 'ack-rejection')).toEqual(rejected);
        expect(mutationResults).toEqual(sink === 'mutating' ? [false, false] : []);
    });

    it.each(['collecting', 'absent', 'throwing', 'mutating'] as const)(
        'distinguishes the runtime aggregate refusal after a lawful competing 1/1 completion with a %s sink',
        async (sink) => {
            const gate = createAckAuthorizerGate('ack-A');
            const events: WsQueueBoxServerReceiptObservation[] = [];
            const mutationResults: boolean[] = [];
            const observe: WsQueueBoxServerReceiptObserver = (event) => {
                events.push(event);
                if (event.kind === 'ack-rejection' && sink === 'mutating') {
                    mutationResults.push(Reflect.set(event, 'controlMsgId', 'forged'));
                    mutationResults.push(Reflect.set(event.failedGuards, '0', 'forged'));
                }
                if (sink === 'throwing') {
                    throw new Error('optional sink failed');
                }
            };
            const service = await createObservedServer(sink === 'absent' ? undefined : observe, undefined, { authorizer: gate.authorizer });
            expect((await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin')).right?.kind).toBe('admitted');
            const messageA = {
                ...createReceiverAcknowledgement(),
                id: { v: 4, msgId: 'ack-A', senderId: 'recipient', ts: 900, traceId: 'trace-ws-queue-box-server-receipt-observation' }
            };
            const messageB = {
                ...createReceiverAcknowledgement(),
                id: { v: 4, msgId: 'ack-B', senderId: 'recipient', ts: 901, traceId: 'trace-ws-queue-box-server-receipt-observation' }
            };
            const pendingA = service.acceptIncomingMessage(messageA, 'recipient');
            await gate.entered;
            const acceptedB = await service.acceptIncomingMessage(messageB, 'recipient');
            expect(acceptedB.left).toBeUndefined();
            expect(acceptedB.right?.kind).toBe('control');
            gate.release();
            expect((await pendingA).left).toEqual({ code: 'unauthorized', message: 'AL acknowledgement names no receipt this server aggregates' });
            expect(await readCompleteReceipts(service)).toMatchObject([{
                expectedRecipientPeerIds: ['recipient'],
                confirmedRecipientPeerIds: ['recipient'],
                phase: 'complete'
            }]);
            if (sink === 'absent') {
                expect(events).toEqual([]);
            }
            else {
                expect(events.filter((event) => event.kind === 'ack-rejection')).toEqual([{
                    kind: 'ack-rejection',
                    serverPeerId: 'server',
                    controlMsgId: 'ack-A',
                    controlSenderId: 'recipient',
                    controlCreatedAtEpochMs: 900,
                    rejectionCode: 'unauthorized',
                    owner: 'receipt-aggregation',
                    stage: 'runtime-protocol',
                    failedGuards: ['aggregate-absent'],
                    validationAtEpochMs: expect.any(Number),
                    deadlineAtMs: undefined
                }]);
            }
            if (sink === 'mutating') {
                expect(mutationResults).toEqual([false, false]);
            }
        }
    );

    it.each(['connection-replaced', 'connection-closed'] as const)(
        'records only the actual post-authorizer %s guard and leaves the aggregate uncounted',
        async (guard) => {
            const gate = createAckAuthorizerGate('ack-1');
            const events: WsQueueBoxServerReceiptObservation[] = [];
            const service = await createObservedServer((event) => events.push(event), undefined, { authorizer: gate.authorizer });
            expect((await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin')).right?.kind).toBe('admitted');
            const message = createReceiverAcknowledgement();
            const pending = service.acceptIncomingMessage(message, 'recipient');
            await gate.entered;
            const original = service.socket.connections.get('recipient')!;
            if (guard === 'connection-replaced') {
                await replaceRecipientConnection(service.socket);
            }
            else {
                original.socket.close();
            }
            expect(original.isOpen).toBe(false);
            gate.release();
            expect((await pending).left).toEqual({ code: 'unauthorized', message: 'WS connection changed during authorization' });
            expect(events.filter((event) => event.kind === 'ack-rejection')).toEqual([{
                kind: 'ack-rejection',
                serverPeerId: 'server',
                controlMsgId: 'ack-1',
                controlSenderId: 'recipient',
                controlCreatedAtEpochMs: message.id.ts,
                rejectionCode: 'unauthorized',
                owner: 'inbound-authority',
                stage: 'post-authorizer-currentness',
                connectionId: 'recipient',
                failedGuards: [guard]
            }]);
            expect(events).toContainEqual(expect.objectContaining({ kind: 'socket-decision', scopeDisposition: 'authorized', outcome: 'rejected' }));
            expect(events.filter((event) => event.kind === 'ack-count')).toEqual([]);
            const retry = { ...createReceiverAcknowledgement(), id: { ...createReceiverAcknowledgement().id, msgId: 'ack-retry' } };
            if (guard === 'connection-closed') {
                await replaceRecipientConnection(service.socket);
            }
            expect((await service.acceptIncomingMessage(retry, 'recipient')).right?.kind).toBe('control');
            expect(events).toContainEqual(expect.objectContaining({ kind: 'ack-count', outcome: 'complete' }));
        }
    );
});

function createObservedAggregation(
    observe: WsQueueBoxServerReceiptObserver | undefined,
    enqueue: WsQueueBoxServerReceiptAggregation.Dependencies['enqueueOutbox'],
    effects: ReceiptAggregationFixtureEffects = {}
): ObservedReceiptAggregation {
    const clock = effects.clock ?? { value: 1000 };
    const aggregation = new WsQueueBoxServerReceiptAggregation({
        serverPeerId: 'server',
        clock: { nowMs: () => clock.value },
        newControlId: () => 'receipt-control',
        qosProvider: undefined,
        queueEngine: new InboxOutboxEngine(),
        enqueueOutbox: enqueue,
        acceptServerControl: async () => ({ kind: 'not-handled' }),
        acceptServerReceipt: effects.acceptServerReceipt ?? (async () => ({ kind: 'not-handled' })),
        receiptObserver: observe
    });
    aggregation.recordAdmission({
        msgId: 'subject',
        originPeerId: 'origin',
        traceId: 'trace-ws-queue-box-server-receipt-observation',
        expectedRecipientPeerIds: ['recipient', 'other'],
        snapshotVersion: 7,
        deadlineAtMs: 30000
    });
    onTestFinished(() => aggregation.dispose());
    return { aggregation, clock };
}

function createObservedAuthority(
    socket: JsonWebSocketServer,
    aggregation: WsQueueBoxServerReceiptAggregation,
    authorizeInboundMessage: WsQueueBoxServerInboundAuthority.Dependencies['authorizeInboundMessage'] = Either.ofRight
): WsQueueBoxServerInboundAuthority {
    const clock = { nowMs: () => 1000 };
    const controlDelivery = new WsQueueBoxServerControlDelivery({
        clock,
        liveDelivery: {
            sendToResolvedPeer: () => {
                throw new Error('no control send expected');
            }
        },
        clusterPublication: { hasPublisher: () => false },
        outbound: {
            enqueueIfAbsent: async () => {
                throw new Error('no enqueue expected');
            }
        }
    });
    const ackRelay = new WsQueueBoxServerAckRelay({
        serverPeerId: 'server',
        clock,
        receipts: aggregation,
        readIngressAudience: async () => undefined,
        publishRelayedAck: undefined
    });
    return new WsQueueBoxServerInboundAuthority({
        socket,
        observesReceipts: true,
        serverPeerId: 'server',
        clock,
        newControlId: () => 'nack',
        targetResolution: new WsQueueBoxServerTargetResolution({ socket, targetResolver: {} }),
        controlDelivery,
        ackRelay,
        authorizeInboundMessage,
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs: 30000 })
    });
}

describe('admission currentness observation at the owned authority boundary', () => {
    it.each(['disposed', 'room-without-authorizer'] as const)('preserves the %s pending exit before application policy', async (state) => {
        const socket = new JsonWebSocketServer();
        const { aggregation } = createObservedAggregation(undefined, async () => {
            throw new Error('No pending admission enqueue expected');
        });
        const authority = createObservedAuthority(socket, aggregation, () => {
            throw new Error('Early pending exit must not invoke application policy');
        });
        onTestFinished(() => authority.dispose());
        if (state === 'disposed') {
            authority.dispose();
        }

        expect(await authority.readCurrentDispatchAuthority(createRoomSubjectMessage())).toBe(state === 'disposed' ? 'retry' : 'completed');
    });

    it.each(['connection-replaced', 'connection-closed'] as const)('identifies the actual second %s check from its returned fact', async (guard) => {
        const socket = new JsonWebSocketServer();
        await replaceRecipientConnection(socket);
        const { aggregation } = createObservedAggregation(undefined, async () => {
            throw new Error('no enqueue expected');
        });
        const authority = createObservedAuthority(socket, aggregation);
        const candidate = await authority.readSocketAdmission(Either.ofRight(createReceiverAcknowledgement()), 'recipient');
        expect(candidate.kind).toBe('candidate');
        if (candidate.kind !== 'candidate') {
            throw new Error('Expected live authorized ACK candidate');
        }
        const original = candidate.value.origin.connection;
        if (guard === 'connection-replaced') {
            await replaceRecipientConnection(socket);
        }
        else {
            original.socket.close();
        }
        const result = authority.resolveAuthorizedSocketAdmission(candidate.value, 'recipient');
        expect(result.kind).toBe('finished');
        if (result.kind !== 'finished') {
            throw new Error('Expected currentness rejection');
        }
        expect(result.result.left).toEqual({ code: 'unauthorized', message: 'WS connection changed during authorization' });
        expect(result.currentnessRejection).toEqual({ stage: 'admission-currentness', failedGuards: [guard] });
        expect(Object.isFrozen(result.currentnessRejection)).toBe(true);
        expect(Object.isFrozen(result.currentnessRejection?.failedGuards)).toBe(true);
    });
});

describe('owned receipt count observation', () => {
    it('preserves every coexisting protocol issue in validation order without changing its rejection prose', () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation, clock } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('no enqueue expected');
        });
        const payload = createReceiverAcknowledgementPayload();
        expect(aggregation.recordAck(payload).right?.receipt).toBeUndefined();
        clock.value = 30000;
        const invalid = { ...payload, toPeerId: 'wrong', fromPeerId: 'other' };
        const identity: ALMessage['id'] = { v: 4, msgId: 'repeated', senderId: 'other', ts: 900, traceId: 'trace-ws-queue-box-server-receipt-observation' };
        expect(aggregation.readRelayedAckRejection(invalid, { stage: 'ingress-protocol', controlIdentity: identity })).toEqual({
            code: 'unauthorized',
            message:
                'AL acknowledgement is not addressed to the origin it names; AL acknowledgement speaks for another recipient than its sender; AL acknowledgement confirms a peer the receipt already counted; AL acknowledgement arrived after its receipt deadline'
        });
        expect(events).toContainEqual({
            kind: 'ack-rejection',
            serverPeerId: 'server',
            controlMsgId: 'repeated',
            controlSenderId: 'other',
            controlCreatedAtEpochMs: 900,
            rejectionCode: 'unauthorized',
            owner: 'receipt-aggregation',
            stage: 'ingress-protocol',
            failedGuards: ['origin-addressee-mismatch', 'sender-recipient-mismatch', 'already-confirmed', 'deadline-expired'],
            validationAtEpochMs: 30000,
            deadlineAtMs: 30000
        });
        expect(aggregation.recordAck(invalid).left?.message).toBe(
            'AL acknowledgement is not addressed to the origin it names; AL acknowledgement speaks for another recipient than its sender; AL acknowledgement confirms a peer the receipt already counted; AL acknowledgement arrived after its receipt deadline'
        );
        const outside = { ...invalid, logicalRecipientPeerId: 'outside' };
        expect(aggregation.readRelayedAckRejection(outside, { stage: 'runtime-protocol', controlIdentity: identity })?.code).toBe('unauthorized');
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'ack-rejection',
            stage: 'runtime-protocol',
            failedGuards: ['origin-addressee-mismatch', 'sender-recipient-mismatch', 'outside-frozen-audience', 'deadline-expired']
        }));
    });

    it('preserves rejection and skips identity projection when the observer or control identity is absent', () => {
        for (const sink of ['absent', 'throwing'] as const) {
            let identityReads = 0;
            let clockReads = 0;
            const identity: ALMessage['id'] = {
                v: 4,
                msgId: 'ack-1',
                senderId: 'recipient',
                get ts(): number {
                    identityReads += 1;
                    throw new Error('projection failure');
                },
                traceId: 'trace-ws-queue-box-server-receipt-observation'
            };
            const { aggregation } = createObservedAggregation(
                sink === 'absent' ? undefined : () => {
                    throw new Error('sink failure');
                },
                async () => {
                    throw new Error('no enqueue expected');
                },
                {
                    clock: {
                        get value() {
                            clockReads += 1;
                            return 1000;
                        }
                    }
                }
            );
            aggregation.sweep(30000);
            clockReads = 0;
            expect(aggregation.readRelayedAckRejection(createReceiverAcknowledgementPayload(), { stage: 'ingress-protocol', controlIdentity: identity }))
                .toEqual({
                    code: 'unauthorized',
                    message: 'AL acknowledgement names no receipt this server aggregates'
                });
            expect(aggregation.readRelayedAckRejection(createReceiverAcknowledgementPayload())).toEqual({
                code: 'unauthorized',
                message: 'AL acknowledgement names no receipt this server aggregates'
            });
            expect(identityReads).toBe(sink === 'absent' ? 0 : 1);
            expect(clockReads).toBe(2);
        }
    });

    it('retains partial, duplicate, outside-audience and deadline decisions with the owned clock and exact frozen sets', () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation, clock } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('no enqueue expected');
        });
        const payload = createReceiverAcknowledgementPayload();
        expect(aggregation.recordAck(payload).right?.receipt).toBeUndefined();
        expect(aggregation.recordAck(payload).left?.code).toBe('unauthorized');
        expect(aggregation.recordAck({ ...payload, fromPeerId: 'outside', logicalRecipientPeerId: 'outside' }).left?.code).toBe('unauthorized');
        clock.value = 30000;
        expect(aggregation.recordAck({ ...payload, fromPeerId: 'other', logicalRecipientPeerId: 'other' }).left?.code).toBe('unauthorized');
        expect(aggregation.sweep(30000)).toMatchObject([
            { receipt: { phase: 'timed-out', confirmedRecipientPeerIds: ['recipient'] } }
        ]);
        expect(events.map((event) => event.kind === 'ack-count' ? { source: event.source, clock: event.countAtEpochMs, outcome: event.outcome } : undefined))
            .toEqual([
                { source: 'direct', clock: 1000, outcome: 'partial' },
                { source: 'direct', clock: 1000, outcome: 'rejected' },
                { source: 'direct', clock: 1000, outcome: 'rejected' },
                { source: 'direct', clock: 30000, outcome: 'rejected' }
            ]);
        expect(events[0]).toMatchObject({ before: { confirmedRecipientPeerIds: [] }, after: { confirmedRecipientPeerIds: ['recipient'] } });
        expect(events[1]).toMatchObject({ before: { confirmedRecipientPeerIds: ['recipient'] }, after: { confirmedRecipientPeerIds: ['recipient'] } });
        expect(events[3]).toMatchObject({ before: { expectedRecipientPeerIds: ['recipient', 'other'], deadlineAtMs: 30000 } });
    });

    it('records the actual returned outbox verdict after enqueue and never turns a thrown enqueue into a verdict', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        let fail = false;
        const { aggregation } = createObservedAggregation((event) => events.push(event), async (message) => {
            if (fail) {
                throw new Error('enqueue failure');
            }
            return { message, verdict: { kind: 'duplicate' }, entries: [], trackedReceiptAlgo: 'none' };
        });
        await aggregation.acceptControlMessage(createReceiverAcknowledgement());
        await aggregation.acceptControlMessage(createReceiverAcknowledgement('other'));
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'receipt-outbox',
                    receiptControlMsgId: 'receipt-control',
                    verdict: { kind: 'duplicate' },
                    receipt: expect.objectContaining({ phase: 'complete' })
                })
            ])
        );
        aggregation.recordAdmission({
            msgId: 'subject',
            originPeerId: 'origin',
            traceId: 'trace-ws-queue-box-server-receipt-observation',
            expectedRecipientPeerIds: ['recipient'],
            snapshotVersion: 7,
            deadlineAtMs: 30000
        });
        fail = true;
        const before = events.length;
        await expect(aggregation.acceptControlMessage(createReceiverAcknowledgement())).rejects.toThrow('enqueue failure');
        expect(events.slice(before)).toMatchObject([{ kind: 'ack-count', outcome: 'complete' }]);
    });
});

describe('owned ACK relay observation', () => {
    it('keeps an unowned fixed-address refusal at its actual relay owner without a parallel provenance classification', () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('no enqueue expected');
        });
        const relay = new WsQueueBoxServerAckRelay({
            serverPeerId: 'other-server',
            clock: { nowMs: () => 1000 },
            receipts: aggregation,
            readIngressAudience: async () => undefined,
            publishRelayedAck: async () => Either.ofRight('published'),
            receiptObserver: (event) => events.push(event)
        });
        const invalid = { ...createReceiverAcknowledgementPayload(), ackedMsgId: 'unowned', toPeerId: 'wrong' };
        expect(
            relay.readRelayedAckRejection(invalid, {
                stage: 'ingress-protocol',
                controlIdentity: { v: 4, msgId: 'ack-relay', senderId: 'recipient', ts: 900, traceId: 'trace-ws-queue-box-server-receipt-observation' }
            })
        ).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement is not addressed to the origin it names'
        });
        expect(events).toEqual([{
            kind: 'ack-rejection',
            serverPeerId: 'other-server',
            controlMsgId: 'ack-relay',
            controlSenderId: 'recipient',
            controlCreatedAtEpochMs: 900,
            rejectionCode: 'unauthorized',
            owner: 'ack-relay',
            stage: 'ingress-protocol',
            failedGuards: ['origin-addressee-mismatch']
        }]);
        expect(relay.readRelayedAckRejection(invalid)?.code).toBe('unauthorized');
        expect(events).toHaveLength(1);
    });

    it('records a failed publication and leaves the ACK it could not hand over to this instance', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('no receipt expected');
        });
        const relay = new WsQueueBoxServerAckRelay({
            serverPeerId: 'other-server',
            clock: { nowMs: () => 1000 },
            receipts: aggregation,
            readIngressAudience: async () => ['recipient'],
            publishRelayedAck: async () => Either.ofLeft('private transport prose'),
            receiptObserver: (event: WsQueueBoxServerReceiptObservation) => events.push(event)
        });
        const message = createReceiverAcknowledgement();
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'ack') {
            throw new Error('test ACK malformed');
        }
        const remote = newALAckControlMessage(message.id, { ...control.payload, ackedMsgId: 'other-subject' });
        expect((await relay.relayUnownedAck(remote)).right).toBe(false);
        expect(events).toEqual([
            expect.objectContaining({
                kind: 'ack-relay',
                controlMsgId: 'ack-1',
                outcome: 'publication-failed',
                ack: expect.objectContaining({ ackedMsgId: 'other-subject' })
            })
        ]);
    });
});

describe('private evidence does not control delivery', () => {
    it.each(['absent', 'throwing', 'mutating'] as const)(
        'preserves the mandatory settlement exception and complete outbox effect with a %s sink',
        async (sink) => {
            const events: WsQueueBoxServerReceiptObservation[] = [];
            const mutationResults: boolean[] = [];
            const { aggregation } = createObservedAggregation(
                sink === 'absent' ? undefined : (event) => {
                    events.push(event);
                    if (sink === 'mutating') {
                        mutationResults.push(Reflect.set(event, 'kind', 'forged'));
                    }
                    if (sink === 'throwing') {
                        throw new Error('optional sink failed');
                    }
                },
                async (message) => ({ message, verdict: { kind: 'duplicate' }, entries: [], trackedReceiptAlgo: 'none' }),
                {
                    acceptServerReceipt: async () => {
                        throw new Error('mandatory settlement failed');
                    }
                }
            );
            await aggregation.acceptControlMessage(createReceiverAcknowledgement());
            await expect(aggregation.acceptControlMessage(createReceiverAcknowledgement('other'))).rejects.toThrow('mandatory settlement failed');
            expect(aggregation.recordAck(createReceiverAcknowledgementPayload()).left?.message).toBe(
                'AL acknowledgement names no receipt this server aggregates'
            );
            if (sink !== 'absent') {
                expect(events).toContainEqual(
                    expect.objectContaining({ kind: 'receipt-outbox', receipt: expect.objectContaining({ phase: 'complete' }), verdict: { kind: 'duplicate' } })
                );
            }
            if (sink === 'mutating') {
                expect(mutationResults.length).toBeGreaterThan(0);
                expect(mutationResults.every((result) => result === false)).toBe(true);
            }
        }
    );

    it('retains scope refusal from the already-read authority proof without counting', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => events.push(event), 0);
        const result = await service.acceptIncomingMessage(createReceiverAcknowledgement(), 'recipient');
        expect(result.left?.code).toBe('unauthorized');
        expect(events).toMatchObject([{
            kind: 'socket-decision',
            fromPeerId: 'recipient',
            authenticatedScope: SCOPE,
            scopeDisposition: 'refused',
            scopeAtEpochMs: expect.any(Number),
            outcome: 'rejected'
        }]);
        events.length = 0;
        expect((await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin')).left?.code).toBe('unauthorized');
        expect(events).toMatchObject([{
            kind: 'business-socket-decision',
            fromPeerId: 'origin',
            authenticatedScope: SCOPE,
            scopeDisposition: 'refused',
            outcome: 'rejected',
            rejectionCode: 'unauthorized'
        }]);
    });

    it('keeps real socket results and aggregate state when the immutable sink throws', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const immutableChecks: boolean[] = [];
        const service = await createObservedServer((event) => {
            events.push(event);
            immutableChecks.push(Object.isFrozen(event));
            if (event.kind === 'ack-count' && event.after !== undefined) {
                immutableChecks.push(Object.isFrozen(event.after.confirmedRecipientPeerIds));
                immutableChecks.push(!Reflect.set(event.after.confirmedRecipientPeerIds, '0', 'forged'));
            }
            if (event.kind === 'business-socket-decision') {
                if (event.authenticatedScope !== undefined) {
                    immutableChecks.push(Object.isFrozen(event.authenticatedScope));
                    immutableChecks.push(!Reflect.set(event.authenticatedScope, 'applicationId', 'forged'));
                }
                immutableChecks.push(!Reflect.set(event, 'msgId', 'forged'));
            }
            throw new Error('sink failed');
        });
        expect((await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin')).right?.kind).toBe('admitted');
        expect((await service.acceptIncomingMessage(createReceiverAcknowledgement(), 'recipient')).right?.kind).toBe('control');
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'business-socket-decision', msgId: 'subject', authenticatedScope: SCOPE, outcome: 'admitted' }),
            expect.objectContaining({ kind: 'ack-count', outcome: 'complete', after: expect.objectContaining({ confirmedRecipientPeerIds: ['recipient'] }) }),
            expect.objectContaining({
                kind: 'receipt-outbox',
                receipt: expect.objectContaining({ phase: 'complete', confirmedRecipientPeerIds: ['recipient'] })
            })
        ]));
        expect(immutableChecks.length).toBeGreaterThan(0);
        expect(immutableChecks.every(Boolean)).toBe(true);
        const disabled = await createObservedServer(undefined);
        expect((await disabled.acceptIncomingMessage(createRoomSubjectMessage(), 'origin')).right?.kind).toBe('admitted');
        expect((await disabled.acceptIncomingMessage(createReceiverAcknowledgement(), 'recipient')).right?.kind).toBe('control');
    });

    it('publishes the business decision after the actual admitted receipt effects even when its sink changes the clock', async () => {
        const clock = { value: 1000 };
        vi.spyOn(Date, 'now').mockImplementation(() => clock.value);
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const completedEffects: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => {
            events.push(event);
            if (event.kind === 'business-socket-decision') {
                completedEffects.push(...events.filter((existing) => existing.kind === 'receipt-outbox'));
                clock.value = 90000;
            }
        });
        const accepted = await service.acceptIncomingMessage(createRoomSubjectMessage(), 'origin');
        expect(accepted.left).toBeUndefined();
        expect(accepted.right?.kind).toBe('admitted');
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'receipt-outbox',
            receipt: expect.objectContaining({ phase: 'admitted' }),
            verdict: expect.objectContaining({ kind: 'admitted', durable: true })
        }));
        expect(events).toContainEqual(expect.objectContaining({ kind: 'business-socket-decision', outcome: 'admitted' }));
        expect(completedEffects).toMatchObject([{
            kind: 'receipt-outbox',
            deadlineAtMs: 31000,
            receipt: { phase: 'admitted', observedAtEpochMs: 1000 },
            verdict: { kind: 'admitted', durable: true }
        }]);
        expect(clock.value).toBe(90000);
    });

    it('copies actual enqueue facts before settlement and publishes after its effects even when it throws', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const order: string[] = [];
        const verdict = { kind: 'admitted' as const, durable: true, queuedAttempts: 2 };
        const { aggregation } = createObservedAggregation((event) => {
            order.push(event.kind);
            events.push(event);
        }, async (message) => {
            order.push('enqueue');
            Reflect.set(message.id, 'msgId', 'mutated-control');
            return { message, verdict, entries: [], trackedReceiptAlgo: 'none' };
        }, {
            acceptServerReceipt: async () => {
                order.push('settle');
                verdict.durable = false;
                verdict.queuedAttempts = 99;
                throw new Error('settlement failure');
            }
        });
        await aggregation.acceptControlMessage(createReceiverAcknowledgement());
        await expect(aggregation.acceptControlMessage(createReceiverAcknowledgement('other'))).rejects.toThrow('settlement failure');
        expect(order).toEqual(['ack-count', 'enqueue', 'settle', 'receipt-outbox', 'ack-count']);
        expect(events.find((event) => event.kind === 'receipt-outbox')).toMatchObject({
            kind: 'receipt-outbox',
            receiptControlMsgId: 'receipt-control',
            verdict: { kind: 'admitted', durable: true, queuedAttempts: 2 },
            receipt: { confirmedRecipientPeerIds: ['recipient', 'other'] }
        });
    });

    it('counts the actual subscriber publisher as relayed provenance without receiving-socket facts', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('partial only');
        });
        const relay = new WsQueueBoxServerAckRelay({
            serverPeerId: 'server',
            clock: { nowMs: () => 1000 },
            receipts: aggregation,
            readIngressAudience: async () => undefined,
            publishRelayedAck: undefined
        });
        await installRelayedAckNoticeSubscriber({
            publisherId: 'owner-publisher',
            channel: 'ws-channel',
            transport: {
                publish: async () => {},
                subscribe: async (_channel, onNotice) => {
                    const notice =
                        toRelayedAckNotice({ publisherId: 'other-publisher', channel: 'ws-channel', message: createReceiverAcknowledgement() }).right;
                    if (notice === undefined) {
                        throw new Error('test ACK notice malformed');
                    }
                    await onNotice(notice);
                }
            },
            acceptRelayedAck: (message, publisherId) => relay.acceptRelayedAck(message, publisherId)
        });
        expect(events).toMatchObject([{
            kind: 'ack-count',
            source: 'relayed',
            relayPublisherId: 'other-publisher',
            controlMsgId: 'ack-1',
            outcome: 'partial'
        }]);
        expect(events[0]).not.toHaveProperty('authenticatedScope');
        expect(events[0]).not.toHaveProperty('connectionId');
    });
});

it('publishes count evidence after the existing control receipt effects so sink clock changes cannot change them', async () => {
    const events: WsQueueBoxServerReceiptObservation[] = [];
    const effects: ReceiptSettlementEffect[] = [];
    const clock = { value: 1000 };
    const mutationResults: boolean[] = [];
    const fixture = createObservedAggregation((event) => {
        events.push(event);
        if (event.kind === 'ack-count') {
            clock.value = 90000;
            if (event.after !== undefined) {
                mutationResults.push(Reflect.set(event.after.confirmedRecipientPeerIds, '0', 'forged'));
            }
        }
    }, async (message) => {
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'receipt') {
            throw new Error('Expected an actual receipt at the enqueue port');
        }
        effects.push({ kind: 'enqueue', clock: clock.value, confirmed: control.payload.confirmedRecipientPeerIds });
        return { message, verdict: { kind: 'duplicate' }, entries: [], trackedReceiptAlgo: 'none' };
    }, {
        clock,
        acceptServerReceipt: async (message) => {
            const control = decodeALControlMessage(message).right;
            if (control?.type !== 'receipt') {
                throw new Error('Expected an actual receipt at the settlement port');
            }
            effects.push({ kind: 'settle', clock: clock.value, confirmed: control.payload.confirmedRecipientPeerIds });
            return { kind: 'not-handled' };
        }
    });
    fixture.aggregation.sweep(30000);
    fixture.aggregation.recordAdmission({
        msgId: 'subject',
        originPeerId: 'origin',
        traceId: 'trace-ws-queue-box-server-receipt-observation',
        expectedRecipientPeerIds: ['recipient'],
        snapshotVersion: 7,
        deadlineAtMs: 30000
    });
    await fixture.aggregation.acceptControlMessage(createReceiverAcknowledgement());
    expect(effects).toEqual([
        { kind: 'enqueue', clock: 1000, confirmed: ['recipient'] },
        { kind: 'settle', clock: 1000, confirmed: ['recipient'] }
    ]);
    expect(events.map((event) => event.kind)).toEqual(['receipt-outbox', 'ack-count']);
    expect(mutationResults).toEqual([false]);
});

it('retains the closed actual storage failure cause while excluding arbitrary enqueue prose', async () => {
    const events: WsQueueBoxServerReceiptObservation[] = [];
    const { aggregation } = createObservedAggregation((event) => events.push(event), async (message) => ({
        message,
        verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'PRIVATE_FAILURE_PROSE' },
        entries: [],
        trackedReceiptAlgo: 'none'
    }));
    await aggregation.acceptControlMessage(createReceiverAcknowledgement());
    await aggregation.acceptControlMessage(createReceiverAcknowledgement('other'));
    const event = events.find((event) => event.kind === 'receipt-outbox');
    expect(event).toMatchObject({ verdict: { kind: 'storage-unavailable', cause: 'quota' }, trackedReceiptAlgo: 'none' });
    expect(JSON.stringify(event)).not.toContain('PRIVATE_FAILURE_PROSE');
});

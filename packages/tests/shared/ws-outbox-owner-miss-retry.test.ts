import { Temporal } from '@js-temporal/polyfill';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
    type MockInstance
} from 'vitest';

import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { requeueRemoteWsOutboxDeliveryFailure } from '@shared-server/rallar-system/queue-pubsub/requeue-remote-ws-outbox-delivery-failure.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import type { WsOutboxDeliveryOutcome, WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer,
    type EncodedJsonWebSocketMessage
} from '@shared/websocket/json-web-socket-server.ts';

import { drainEngine } from './alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from './websocket/test-web-socket.ts';

interface WsOutboxTestSocket {
    readonly socket: JsonWebSocketServer;
    readonly sendEncoded: MockInstance<JsonWebSocketServer['sendEncoded']>;
    readonly encodedSends: Array<[string, EncodedJsonWebSocketMessage]>;
}

interface CreateWsOutboxServiceInput {
    readonly outbox: InMemoryQueueBox;
    readonly socket: WsOutboxTestSocket;
    readonly name: string;
    readonly resolveRecipients: () => readonly WsServerResolvedRecipient[];
}

interface WsOutboxServiceFixture {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
}

describe('durable WS outbox owner misses', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        TestWebSocket.instances.length = 0;
    });

    it('retries a non-owner miss so the process with the target socket can deliver', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const outbox = new InMemoryQueueBox();
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(
            createUnicastMessage(),
            EnqueuedType.WS_OUTBOX
        );
        await outbox.enqueue(entry);
        const ownerSocket = createSocket();
        const misses: WsOutboxDeliveryOutcome[] = [];
        const nonOwnerEngine = new InboxOutboxEngine();
        const nonOwner = createDefaultWsQueueBoxServerService({
            outbox: outbox,
            socket: createSocket().socket,
            name: 'server-without-target',
            targetResolver: { resolvePeerRecipients: () => [] },
            outboundDeliveryOutcome: (outcome) => misses.push(outcome),
            queueEngine: nonOwnerEngine
        });
        onTestFinished(() => nonOwner.dispose());
        const ownerEngine = new InboxOutboxEngine();
        const owner = createDefaultWsQueueBoxServerService({
            outbox: outbox,
            socket: ownerSocket.socket,
            name: 'server-with-target',
            targetResolver: {
                resolvePeerRecipients: () => [{ peerId: 'writer-session', connectionId: 'writer-session' }]
            },
            queueEngine: ownerEngine
        });
        onTestFinished(() => owner.dispose());

        // One trigger, then a passive wait for that one attempt to settle: a poll that redrives
        // finds isWork() false while the prior attempt is still in flight (its own batch guard), so
        // it can spin past the real-time poll timeout without ever giving that attempt a turn.
        await drainEngine(nonOwnerEngine);
        await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);
        expect((await readEntry(outbox)).status).toBe(EntityStatus.RETRY);
        expect(misses.length).toBeGreaterThanOrEqual(1);
        expect(misses.every((outcome) =>
            JSON.stringify(outcome) === JSON.stringify({
                status: 'no-current-recipient',
                messageId: 'durable-reply-1'
            })
        )).toBe(true);

        vi.advanceTimersByTime(1);
        await drainEngine(ownerEngine);
        await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);
        expect((await readEntry(outbox)).status).toBe(EntityStatus.COMPLETED);
        expect(ownerSocket.sendEncoded).toHaveBeenCalledWith('writer-session', expect.anything());
    });

    it('redrives a durable send after a shared admission claim conflict', async () => {
        const outbox = new InMemoryQueueBox();
        await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
            createUnicastMessage(),
            EnqueuedType.WS_OUTBOX
        ));
        const ownerSocket = createSocket();
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), Date.now);
        const admissionStore = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'ws-owner-claim-conflict',
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            namespace: 'ws-owner-claim-conflict',
            supersedenceTrackTtlMs: 60_000,
            backend,
            retention: normalizeALRuntimeStoreRetention()
        });
        let claimCalls = 0;
        const reserveEntries = backend.workQueue.reserveEntries.bind(backend.workQueue);
        vi.spyOn(backend.workQueue, 'reserveEntries').mockImplementation(async (input) => {
            claimCalls += 1;
            if (claimCalls === 2) {
                throw new ALAdmissionBackendConflictError('simulated shared claim race');
            }
            return await reserveEntries(input);
        });
        // Started explicitly so the runtime's own retry keeps ticking after the initial drain below,
        // the way an owned engine would while the claim conflict resolves.
        const engine = new InboxOutboxEngine();
        engine.start();
        onTestFinished(() => engine.stop());
        const owner = createDefaultWsQueueBoxServerService({
            outbox: outbox,
            socket: ownerSocket.socket,
            name: 'server-with-target',
            targetResolver: {
                resolvePeerRecipients: () => [{ peerId: 'writer-session', connectionId: 'writer-session' }]
            },
            outboundStores: { admissionStore, workQueue: backend.workQueue },
            queueEngine: engine
        });
        onTestFinished(() => owner.dispose());

        await drainEngine(engine);
        await vi.waitFor(() => {
            expect(claimCalls).toBeGreaterThanOrEqual(3);
            expect(ownerSocket.sendEncoded).toHaveBeenCalledWith('writer-session', expect.anything());
        });
    });

    it('publishes a wrong-claimant outbox key so the socket owner delivers it', async () => {
        const outbox = new InMemoryQueueBox();
        await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
            createUnicastMessage(),
            EnqueuedType.WS_OUTBOX
        ));
        const bus = createBridgeBus();
        const ownerSocket = createSocket();
        const { service: nonOwner, engine: nonOwnerEngine } = createService({
            outbox,
            socket: createSocket(),
            name: 'non-owner',
            resolveRecipients: () => []
        });
        const { service: owner } = createService({
            outbox,
            socket: ownerSocket,
            name: 'owner',
            resolveRecipients: () => [
                { peerId: 'writer-session', connectionId: 'writer-session' }
            ]
        });
        installQueueBoxPubSubBridge({
            wsQBoxServerService: nonOwner,
            bridge: bus,
            channel: 'ws',
            publisherId: 'non-owner'
        });
        installQueueBoxPubSubBridge({
            wsQBoxServerService: owner,
            bridge: bus,
            channel: 'ws',
            publisherId: 'owner'
        });

        await drainEngine(nonOwnerEngine);
        await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);
        expect((await readEntry(outbox)).status).toBe(EntityStatus.COMPLETED);
        expect(ownerSocket.sendEncoded).toHaveBeenCalledWith('writer-session', expect.anything());
    });

    it('delivers a distributed broadcast on the claimant and every remote process', async () => {
        const outbox = new InMemoryQueueBox();
        const broadcast = { ...createUnicastMessage(), targets: { mode: 'broadcast' as const, scope: 'all' as const } };
        await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(broadcast, EnqueuedType.WS_OUTBOX));
        const bus = createBridgeBus();
        const timing: RallarTimingEvent[] = [];
        const claimantSocket = createSocket();
        const remoteSocket = createSocket();
        const { service: claimant, engine: claimantEngine } = createService({
            outbox,
            socket: claimantSocket,
            name: 'claimant',
            resolveRecipients: () => [
                { peerId: 'local-session', connectionId: 'local-session' }
            ]
        });
        const { service: remote } = createService({
            outbox,
            socket: remoteSocket,
            name: 'remote',
            resolveRecipients: () => [
                { peerId: 'remote-session', connectionId: 'remote-session' }
            ]
        });
        installQueueBoxPubSubBridge({
            wsQBoxServerService: claimant,
            bridge: bus,
            channel: 'ws',
            publisherId: 'claimant',

            timing: (event) => timing.push(event)
        });
        installQueueBoxPubSubBridge({
            wsQBoxServerService: remote,
            bridge: bus,
            channel: 'ws',
            publisherId: 'remote',

            timing: (event) => timing.push(event)
        });

        await drainEngine(claimantEngine);
        await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);

        expect(claimantSocket.sendEncoded).toHaveBeenCalledWith('local-session', expect.anything());
        expect(remoteSocket.sendEncoded).toHaveBeenCalledWith('remote-session', expect.anything());
        expect(timing).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'outbox-cluster-publish' }),
            expect.objectContaining({ operation: 'outbox-key-loaded' }),
            expect.objectContaining({
                operation: 'outbox-direct-send',
                details: expect.objectContaining({ recipientCount: 1, sentCount: 1, failedCount: 0 })
            })
        ]));
    });

    it('gates the first remote publication on the actual listener readiness', async () => {
        const outbox = new InMemoryQueueBox();
        const bus = createDelayedSecondSubscriberBridgeBus();
        const { service: claimant, engine: claimantEngine } = createService({
            outbox,
            socket: createSocket(),
            name: 'claimant',
            resolveRecipients: () => []
        });
        const remoteSocket = createSocket();
        const { service: remote } = createService({
            outbox,
            socket: remoteSocket,
            name: 'remote',
            resolveRecipients: () => [
                { peerId: 'writer-session', connectionId: 'writer-session' }
            ]
        });
        const claimantReadiness = installQueueBoxPubSubBridge({
            wsQBoxServerService: claimant,
            bridge: bus,
            channel: 'ws',
            publisherId: 'claimant'
        });
        await claimantReadiness;
        const remoteReadiness = installQueueBoxPubSubBridge({
            wsQBoxServerService: remote,
            bridge: bus,
            channel: 'ws',
            publisherId: 'remote'
        });
        const beforeReadinessKey = createUnicastMessage('published-before-readiness', 'reply-before-readiness').route;
        await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
            createUnicastMessage('published-before-readiness', 'reply-before-readiness'),
            EnqueuedType.WS_OUTBOX
        ));

        // One trigger, then a passive wait for the claimant's own attempt to settle, before the
        // remote subscriber ever joins: a redriving poll risks racing this row past readiness into
        // the second (post-readiness) drain below, defeating the gate this test observes.
        await drainEngine(claimantEngine);
        await expect.poll(async () => (await outbox.getItem(beforeReadinessKey))?.status)
            .not.toBe(EntityStatus.RESERVED);

        expect(remoteSocket.encodedSends).toEqual([]);

        bus.releaseSecondSubscription();
        await remoteReadiness;
        const afterReadinessKey = createUnicastMessage('published-after-readiness', 'reply-after-readiness').route;
        await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
            createUnicastMessage('published-after-readiness', 'reply-after-readiness'),
            EnqueuedType.WS_OUTBOX
        ));

        await drainEngine(claimantEngine);
        await expect.poll(async () => (await outbox.getItem(afterReadinessKey))?.status)
            .not.toBe(EntityStatus.RESERVED);

        expect(remoteSocket.encodedSends).toHaveLength(1);
        expect(remoteSocket.sendEncoded).toHaveBeenCalledWith(
            'writer-session',
            expect.objectContaining({ text: expect.stringContaining('published-after-readiness') })
        );
    });

    it('keeps a published durable message with invalid targets retryable after one attempt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const outbox = new InMemoryQueueBox();
        const invalid = { ...createUnicastMessage(), targets: undefined };
        await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(invalid, EnqueuedType.WS_OUTBOX));
        const { service, engine } = createService({
            outbox,
            socket: createSocket(),
            name: 'claimant',
            resolveRecipients: () => []
        });
        installQueueBoxPubSubBridge({
            wsQBoxServerService: service,
            bridge: createBridgeBus(),
            channel: 'ws',
            publisherId: 'claimant'
        });

        // One pass only: a poll that redrives on every attempt would keep re-claiming this row (its
        // no-route retry becomes due again as fast as fake Date time lets it), inflating the attempt
        // count the assertion below pins. Trigger once, then passively wait for that pass to settle.
        await drainEngine(engine);
        await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);

        expect(await readEntry(outbox)).toMatchObject({
            status: EntityStatus.RETRY,
            dequeueAudit: { attempts: 1 }
        });
    });

    it('retries the durable row when cluster publication fails', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const outbox = new InMemoryQueueBox();
        await outbox.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(
            createUnicastMessage(),
            EnqueuedType.WS_OUTBOX
        ));
        const { service, engine } = createService({
            outbox,
            socket: createSocket(),
            name: 'claimant',
            resolveRecipients: () => []
        });
        const bus = {
            ...createBridgeBus(),
            publish: async () => {
                throw new Error('simulated pub/sub outage');
            }
        };
        installQueueBoxPubSubBridge({
            wsQBoxServerService: service,
            bridge: bus,
            channel: 'ws',
            publisherId: 'claimant'
        });

        await drainEngine(engine);
        await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);
        expect((await readEntry(outbox)).status).toBe(EntityStatus.RETRY);
    });

    it.each(['before', 'after'] as const)(
        'durably retries a remote owner send failure %s claimant completion',
        async (race) => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const outbox = new InMemoryQueueBox();
            const original = QueueBoxUtilities.toResourceEntryFromMsg(
                createUnicastMessage(),
                EnqueuedType.WS_OUTBOX
            );
            await outbox.enqueue(original);
            const bus: DrainableBridgeBus = race === 'before'
                ? createBridgeBus()
                : createFireAndForgetBridgeBus();
            const { service: claimant, engine: claimantEngine } = createService({
                outbox,
                socket: createSocket(),
                name: 'claimant',
                resolveRecipients: () => []
            });
            const remoteSocket = createSocket();
            remoteSocket.sendEncoded.mockImplementationOnce(() => {
                throw new Error('simulated remote socket failure');
            });
            const { service: remote } = createService({
                outbox,
                socket: remoteSocket,
                name: 'remote',
                resolveRecipients: () => [
                    { peerId: 'writer-session', connectionId: 'writer-session' }
                ]
            });
            const remoteRetryPolicy = {
                ...createResilience().retryPolicy,
                delaysAfterAttemptMs: [50, 50],
                maxDelayMs: 50
            };
            installQueueBoxPubSubBridge({
                wsQBoxServerService: claimant,
                bridge: bus,
                channel: 'ws',
                publisherId: 'claimant'
            });
            installQueueBoxPubSubBridge({
                wsQBoxServerService: remote,
                bridge: bus,
                channel: 'ws',
                publisherId: 'remote',

                retryPolicy: remoteRetryPolicy,
                jitterUnit: () => 0
            });

            // One trigger, then a passive wait for that one attempt to reach the bus before draining
            // it: a poll that redrives would race the row past the RETRY state this assertion
            // observes and on toward completion, and draining the bus before the publish reaches it
            // (the fire-and-forget race) would find nothing queued yet.
            await drainEngine(claimantEngine);
            await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);
            await bus.drain?.();

            const retry = await readEntry(outbox);
            expect(retry.status).toBe(EntityStatus.RETRY);
            expect(retry.resource).toBe(original.resource);
            expect(decodePersistedALMessage(retry.resource).id.msgId).toBe('durable-reply-1');
            await expect(requeueRemoteWsOutboxDeliveryFailure(outbox, retry, {
                retryPolicy: remoteRetryPolicy,
                jitterUnit: () => 0
            })).resolves.toBeUndefined();
            await expect(requeueRemoteWsOutboxDeliveryFailure(
                outbox,
                { ...retry, resource: `${retry.resource} ` },
                { retryPolicy: remoteRetryPolicy, jitterUnit: () => 0 }
            )).resolves.toBeUndefined();

            vi.advanceTimersByTime(55);
            await drainEngine(claimantEngine);
            await expect.poll(async () => (await readEntry(outbox)).status).not.toBe(EntityStatus.RESERVED);
            await bus.drain?.();

            expect(await readEntry(outbox)).toMatchObject({
                status: EntityStatus.COMPLETED,
                resource: original.resource,
                dequeueAudit: { attempts: 2 }
            });
            expect(remoteSocket.sendEncoded).toHaveBeenCalledTimes(2);
        }
    );
});

function createUnicastMessage(
    msgId = 'durable-reply-1',
    resourceId = 'reply-1'
): ALMessage {
    return {
        id: { v: 2, msgId, ts: Date.now(), senderId: 'server-worker' },
        route: { topicId: 'app.crdt', resourceId, contextId: 'rallar-server' },
        targets: { mode: 'unicast', toPeerId: 'writer-session' },
        constraints: { expiresAtMs: Date.now() + 60_000 },
        payload: { typeId: 'rallar.crdt.append-response.v1', contentType: 'application/json', resource: '{}' },
        audit: { createdBy: 'server-worker', createdTs: Date.now() }
    };
}

function createSocket(): WsOutboxTestSocket {
    const socket = new JsonWebSocketServer();
    for (const id of ['writer-session', 'local-session', 'remote-session']) {
        const connection = new TestWebSocket(`ws://${id}.invalid`);
        connection.open();
        socket.addConnection(new ConnectionContext({ id, socket: connection }));
    }
    const encodedSends: Array<[string, EncodedJsonWebSocketMessage]> = [];
    const send = socket.sendEncoded.bind(socket);
    const sendEncoded = vi.spyOn(socket, 'sendEncoded').mockImplementation(
        (connectionId: string, encoded: EncodedJsonWebSocketMessage) => {
            send(connectionId, encoded);
            encodedSends.push([connectionId, encoded]);
        }
    );
    return { socket, sendEncoded, encodedSends };
}

function createService(input: CreateWsOutboxServiceInput): WsOutboxServiceFixture {
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: input.outbox,
        socket: input.socket.socket,
        name: input.name,
        targetResolver: {
            resolvePeerRecipients: input.resolveRecipients,
            resolveBroadcastRecipients: input.resolveRecipients
        },
        queueEngine: engine
    });
    onTestFinished(() => service.dispose());
    return { service, engine };
}

function createBridgeBus(): QueueBoxPubSubBridge {
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

interface DrainableBridgeBus extends QueueBoxPubSubBridge {
    drain?(): Promise<void>;
}

function createFireAndForgetBridgeBus(): DrainableBridgeBus {
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    let published: QueueBoxPubSubMessage[] = [];
    return {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            published.push(message);
        },
        drain: async () => {
            const current = published;
            published = [];
            await Promise.allSettled(current.flatMap((message) => subscribers.map(async (subscriber) => await subscriber(message))));
        }
    };
}

interface DelayedBridgeBus extends QueueBoxPubSubBridge {
    releaseSecondSubscription(): void;
}

function createDelayedSecondSubscriberBridgeBus(): DelayedBridgeBus {
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    let subscriptionCount = 0;
    const secondSubscription = Promise.withResolvers<void>();

    return {
        subscribe: async (_channel, subscriber) => {
            subscriptionCount += 1;
            if (subscriptionCount === 2) {
                await secondSubscription.promise;
            }
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(
                subscribers.map(async (subscriber) => await subscriber(message))
            );
        },
        releaseSecondSubscription: () => secondSubscription.resolve()
    };
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        maxFairnessSelectionsInWindow: 10,
        retryPolicy: { maxAttempts: 3, delaysAfterAttemptMs: [1, 1], maxDelayMs: 1, jitterRatio: 0, staleDueThresholdMs: 1 }
    });
}

async function readEntry(queue: InMemoryQueueBox): Promise<ResourceEntry> {
    const entry = await queue.getItem({
        topicId: 'app.crdt',
        resourceId: 'reply-1',
        contextId: 'rallar-server'
    });
    if (!entry) {
        throw new Error('Expected queued entry');
    }
    return entry;
}

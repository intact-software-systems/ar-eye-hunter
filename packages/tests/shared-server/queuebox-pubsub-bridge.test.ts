import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import {
    installQueueBoxPubSubBridge,
    toPubSubMessage,
    toResourceEntryFromPubSubMessage,
    type QueueBoxPubSubBridge,
    type QueueBoxPubSubMessage,
    type QueueBoxPubSubWsService
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server-contracts.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { describe, expect, it, vi } from 'vitest';

type QueueMessageCallback = Parameters<QueueBoxPubSubWsService['onAllInboxMessagesDo']>[0];
type ClusterPublisher = Parameters<QueueBoxPubSubWsService['onOutboxClusterPublishDo']>[0];

interface TestQueueBoxPubSubBridge extends QueueBoxPubSubBridge {
    readonly publish: ReturnType<typeof vi.fn>;
    readonly subscribe: ReturnType<typeof vi.fn>;
    readonly subscriber?: Parameters<QueueBoxPubSubBridge['subscribe']>[1];
}

interface Deferred {
    readonly promise: Promise<void>;
    resolve(): void;
}

describe('QueueBoxPubSubBridge', () => {
    it('exposes the actual transport subscription as readiness', async () => {
        const subscription = createDeferred();
        const timingEvents: RallarTimingEvent[] = [];
        const bridge: QueueBoxPubSubBridge = {
            publish: async () => undefined,
            subscribe: async () => await subscription.promise
        };
        const wsQBoxServerService = createTestQueueBoxPubSubWsService();

        const readiness = installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event)
        });

        expect(readiness).toBeInstanceOf(Promise);
        let ready = false;
        void readiness.then(() => {
            ready = true;
        });
        await Promise.resolve();
        expect(ready).toBe(false);

        subscription.resolve();
        await readiness;

        expect(ready).toBe(true);
        const listenerEvent = timingEvents.find(
            (event) => event.operation === 'listener-subscribe'
        );
        expect(listenerEvent).toMatchObject({
            component: 'queuebox-pubsub',
            operation: 'listener-subscribe',
            status: 'ok',
            details: { channel: 'queuebox-events' }
        });
        expect(Object.keys(listenerEvent?.details ?? {})).toEqual(['channel']);
    });

    it('rejects readiness when the transport subscription fails', async () => {
        const failure = new Error('subscription failed');
        const timingEvents: RallarTimingEvent[] = [];
        const bridge: QueueBoxPubSubBridge = {
            publish: async () => undefined,
            subscribe: async () => {
                throw failure;
            }
        };
        const wsQBoxServerService = createTestQueueBoxPubSubWsService();
        const reportFailure = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);

        const readiness = installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event)
        });

        expect(readiness).toBeInstanceOf(Promise);
        await expect(readiness).rejects.toBe(failure);
        expect(timingEvents).toContainEqual(expect.objectContaining({
            component: 'queuebox-pubsub',
            operation: 'listener-subscribe',
            status: 'error',
            details: { channel: 'queuebox-events' },
            error: {
                name: 'Error',
                message: 'subscription failed'
            }
        }));
        expect(reportFailure).toHaveBeenCalledWith(
            'QueueBox pub/sub bridge listener failed:',
            failure
        );
        reportFailure.mockRestore();
    });

    it('publishes all inbox and outbox entries through the supplied bridge', async () => {
        const inboxCallbacks: QueueMessageCallback[] = [];
        const outboxPublishers: ClusterPublisher[] = [];
        const bridge = createBridge();
        const sendToTargetsWithResult = vi.fn(() => ({
            status: 'sent-live',
            recipientCount: 1,
            sentCount: 1,
            failedCount: 0
        }));
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({
            registerInboxCallback: (callback) => inboxCallbacks.push(callback),
            registerOutboxPublisher: (publisher) => outboxPublishers.push(publisher),
            sendToTargetsWithResult
        });

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1'
        });
        const entry = createWsEntry();

        const message = decodePersistedALMessage(entry.resource);
        await inboxCallbacks[0].onMessage(message, entry, new JsonWebSocketServer());
        await outboxPublishers[0](message, entry);

        expect(bridge.publish).toHaveBeenCalledTimes(2);
        expect(bridge.publish).toHaveBeenCalledWith(
            'queuebox-events',
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-1',
                entry
            })
        );
        expect(bridge.publish).toHaveBeenCalledWith(
            'queuebox-events',
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-1',
                entry,
                delivery: 'key'
            })
        );
        expect(bridge.subscribe).toHaveBeenCalledWith(
            'queuebox-events',
            expect.any(Function)
        );
        expect(sendToTargetsWithResult).toHaveBeenCalledWith(message);
    });

    it('keeps full-entry delivery as the default pub/sub envelope', () => {
        const entry = createWsEntry();

        expect(toPubSubMessage({
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            entry
        })).toEqual({
            key: entry.key,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            typeId: entry.typeId,
            delivery: 'entry',
            payload: entry.resource
        });
    });

    it('can build key-only envelopes without embedding the queue payload', () => {
        const entry = createWsEntry();
        const message = toPubSubMessage({
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            entry,
            delivery: 'key'
        });

        expect(message).toEqual({
            key: entry.key,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            typeId: entry.typeId,
            delivery: 'key'
        });
        expect(JSON.stringify(message)).not.toContain(entry.resource);
    });

    it('enqueues subscribed messages into the local inbox', async () => {
        const bridge = createBridge();
        const inbox = new InMemoryQueueBox();
        const enqueueIfAbsent = vi.spyOn(inbox, 'enqueueIfAbsent');
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ inbox });

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1'
        });

        const entry = createWsEntry();
        await bridge.subscriber?.(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry
            })
        );

        expect(enqueueIfAbsent).toHaveBeenCalledTimes(1);
        expect(enqueueIfAbsent.mock.calls[0][0]).toMatchObject({
            key: entry.key,
            typeId: entry.typeId,
            resource: entry.resource
        });
    });

    it('loads durable queue entries before enqueuing key-only subscribed messages', async () => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const inbox = new InMemoryQueueBox();
        const enqueueIfAbsent = vi.spyOn(inbox, 'enqueueIfAbsent');
        const getItem = vi.spyOn(inbox, 'getItem').mockResolvedValue(entry);
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ inbox });

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event)
        });

        await bridge.subscriber?.(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry,
                delivery: 'key'
            })
        );

        expect(getItem).toHaveBeenCalledWith(entry.key);
        expect(enqueueIfAbsent).toHaveBeenCalledWith(entry);
        const receiveEvent = timingEvents.find(
            (event) => event.operation === 'cluster-receive'
        );
        expect(receiveEvent).toMatchObject({
            component: 'queuebox-pubsub',
            operation: 'cluster-receive',
            status: 'ok',
            details: {
                channel: 'queuebox-events',
                delivery: 'key',
                entryKind: 'ws-inbox'
            }
        });
        expect(Object.keys(receiveEvent?.details ?? {}).sort()).toEqual([
            'channel',
            'delivery',
            'entryKind'
        ]);
    });

    it('reports only exact durable outbox key receives through the optional wake seam', async () => {
        const bridge = createBridge();
        const entry = createWsOutboxEntry();
        const onValidatedOutboxKeyReceived = vi.fn();
        const sendToTargetsWithResult = vi.fn(() => ({
            status: 'no-recipients',
            recipientCount: 0,
            sentCount: 0,
            failedCount: 0
        }));
        const outbox = new InMemoryQueueBox();
        vi.spyOn(outbox, 'getItem').mockResolvedValue(entry);
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({
            outbox,
            sendToTargetsWithResult
        });
        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            onValidatedOutboxKeyReceived
        });

        await bridge.subscriber?.(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry,
                delivery: 'key'
            })
        );
        await bridge.subscriber?.(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry
            })
        );

        expect(onValidatedOutboxKeyReceived).toHaveBeenCalledOnce();
        expect(onValidatedOutboxKeyReceived).toHaveBeenCalledWith(entry);
        expect(sendToTargetsWithResult).toHaveBeenCalledTimes(2);
    });

    it('drops missing durable key-only messages with timing details', async () => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const inbox = new InMemoryQueueBox();
        const enqueueIfAbsent = vi.spyOn(inbox, 'enqueueIfAbsent');
        vi.spyOn(inbox, 'getItem').mockResolvedValue(undefined);
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ inbox });

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event)
        });

        await bridge.subscriber?.(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry,
                delivery: 'key'
            })
        );

        expect(enqueueIfAbsent).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(
            expect.objectContaining({
                component: 'queuebox-pubsub',
                operation: 'key-load-miss',
                status: 'ok',
                details: expect.objectContaining({
                    channel: 'queuebox-events',
                    resourceId: entry.key.resourceId
                })
            })
        );
    });

    it('drops a durable key load whose identity differs from its envelope', async () => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const inbox = new InMemoryQueueBox();
        const enqueueIfAbsent = vi.spyOn(inbox, 'enqueueIfAbsent');
        vi.spyOn(inbox, 'getItem').mockResolvedValue({
            ...entry,
            key: { ...entry.key, resourceId: 'different-resource' }
        });
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ inbox });
        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event)
        });

        await bridge.subscriber?.(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry,
                delivery: 'key'
            })
        );

        expect(enqueueIfAbsent).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(expect.objectContaining({
            operation: 'key-load-mismatch',
            details: expect.objectContaining({ resourceId: entry.key.resourceId })
        }));
    });

    it('drops malformed envelopes with timing details instead of enqueueing them', async () => {
        const bridge = createBridge();
        const timingEvents: RallarTimingEvent[] = [];
        const inbox = new InMemoryQueueBox();
        const enqueueIfAbsent = vi.spyOn(inbox, 'enqueueIfAbsent');
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ inbox });

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event)
        });

        await bridge.subscriber?.({
            channel: 'queuebox-events',
            publisherId: 'publisher-2',
            typeId: EnqueuedType.WS_INBOX,
            delivery: 'entry',
            payload: JSON.stringify({ ok: true })
        } as QueueBoxPubSubMessage);

        expect(enqueueIfAbsent).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(expect.objectContaining({
            component: 'queuebox-pubsub',
            operation: 'drop-malformed',
            status: 'ok'
        }));
    });

    it('rejects subscribed queue entries that are not current AL messages', () => {
        expect(() =>
            toResourceEntryFromPubSubMessage({
                key: {
                    topicId: 'custom',
                    resourceId: 'resource-1',
                    contextId: 'ctx-1'
                },
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                typeId: 'custom.type.v1',
                payload: '{"hello":"world"}'
            })
        ).toThrow(TypeError);
    });
});

function createBridge(): TestQueueBoxPubSubBridge {
    let subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;
    const publish = vi.fn(
        async (_channel: string, _message: QueueBoxPubSubMessage) => undefined
    );
    const subscribe = vi.fn(
        async (
            _channel: string,
            onMessage: Parameters<QueueBoxPubSubBridge['subscribe']>[1]
        ) => {
            subscriber = onMessage;
        }
    );

    return {
        publish,
        subscribe,
        get subscriber() {
            return subscriber;
        }
    };
}

interface CreateTestQueueBoxPubSubWsServiceInput {
    readonly inbox?: InMemoryQueueBox;
    readonly outbox?: InMemoryQueueBox;
    readonly registerInboxCallback?: (callback: QueueMessageCallback) => void;
    readonly registerOutboxPublisher?: (publisher: ClusterPublisher) => void;
    readonly sendToTargetsWithResult?: (
        message: ALMessage
    ) => WsServerLiveSendResult;
}

function createTestQueueBoxPubSubWsService(
    input: CreateTestQueueBoxPubSubWsServiceInput = {}
): QueueBoxPubSubWsService {
    const service: QueueBoxPubSubWsService = {
        inbox: input.inbox ?? new InMemoryQueueBox(),
        outbox: input.outbox ?? new InMemoryQueueBox(),
        onAllInboxMessagesDo(callback) {
            input.registerInboxCallback?.(callback);
            return service;
        },
        onOutboxClusterPublishDo(publisher) {
            input.registerOutboxPublisher?.(publisher);
            return service;
        },
        sendToTargetsWithResult(message) {
            return input.sendToTargetsWithResult?.(message) ?? {
                status: 'no-recipients',
                recipientCount: 0,
                sentCount: 0,
                failedCount: 0
            };
        }
    };

    return service;
}

function createWsEntry(): ResourceEntry {
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Ship bridge' }
        ),
        EnqueuedType.WS_INBOX
    );
}

function createWsOutboxEntry(): ResourceEntry {
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALBroadcastMessage(
            'rallar-server',
            newALRoute('rallar.overlay-topology.v1', 'room-1', 'topology-1'),
            'room',
            'rallar.overlay-topology.v1',
            { version: 1 },
            {
                groupRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                }
            }
        ),
        EnqueuedType.WS_OUTBOX
    );
}

function createDeferred(): Deferred {
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });

    return {
        promise,
        resolve: () => resolvePromise()
    };
}

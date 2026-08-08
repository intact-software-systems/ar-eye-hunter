import { describe, expect, it, vi } from 'vitest';
import { newALBroadcastMessage, newALRoute, } from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    installQueueBoxPubSubBridge,
    type QueueBoxPubSubBridge,
    type QueueBoxPubSubMessage,
    toPubSubMessage,
    toResourceEntryFromPubSubMessage,
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';

type QueueMessageCallback = Readonly<{
    onMessage: (
        message: unknown,
        entry: ResourceEntry,
        server: unknown,
    ) => Promise<void>;
}>;
type ClusterPublisher = (message: unknown, entry: ResourceEntry) => Promise<void>;

describe('QueueBoxPubSubBridge', () => {
    it('exposes the actual transport subscription as readiness', async () => {
        const subscription = createDeferred();
        const timingEvents: RallarTimingEvent[] = [];
        const bridge: QueueBoxPubSubBridge = {
            publish: async () => undefined,
            subscribe: async () => await subscription.promise,
        };
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onOutboxClusterPublishDo: vi.fn().mockReturnThis(),
        } as unknown as WsQueueBoxServerService;

        const readinessValue: unknown = installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event),
        });

        expect(readinessValue).toBeInstanceOf(Promise);
        const readiness = readinessValue as Promise<void>;
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
            (event) => event.operation === 'listener-subscribe',
        );
        expect(listenerEvent).toMatchObject({
            component: 'queuebox-pubsub',
            operation: 'listener-subscribe',
            status: 'ok',
            details: { channel: 'queuebox-events' },
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
            },
        };
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onOutboxClusterPublishDo: vi.fn().mockReturnThis(),
        } as unknown as WsQueueBoxServerService;
        const reportFailure = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);

        const readinessValue: unknown = installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event),
        });

        expect(readinessValue).toBeInstanceOf(Promise);
        await expect(readinessValue as Promise<void>).rejects.toBe(failure);
        expect(timingEvents).toContainEqual(expect.objectContaining({
            component: 'queuebox-pubsub',
            operation: 'listener-subscribe',
            status: 'error',
            details: { channel: 'queuebox-events' },
            error: {
                name: 'Error',
                message: 'subscription failed',
            },
        }));
        expect(reportFailure).toHaveBeenCalledWith(
            'QueueBox pub/sub bridge listener failed:',
            failure,
        );
        reportFailure.mockRestore();
    });

    it('publishes all inbox and outbox entries through the supplied bridge', async () => {
        const inboxCallbacks: QueueMessageCallback[] = [];
        const outboxPublishers: ClusterPublisher[] = [];
        const bridge = createBridge();
        const sendToTargetsWithResult = vi.fn(() => ({
            status: 'sent-live', recipientCount: 1, sentCount: 1, failedCount: 0,
        }));
        const wsQBoxServerService = {
            onAllInboxMessagesDo(callback: QueueMessageCallback) {
                inboxCallbacks.push(callback);
                return this;
            },
            onOutboxClusterPublishDo(callback: ClusterPublisher) {
                outboxPublishers.push(callback);
                return this;
            },
            sendToTargetsWithResult,
            inbox: {
                enqueueIfAbsent: vi.fn(async (entry: ResourceEntry) => entry),
            },
        } as unknown as WsQueueBoxServerService;

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
        });
        const entry = createWsEntry();

        await inboxCallbacks[0].onMessage({}, entry, {});
        await outboxPublishers[0]({}, entry);

        expect(bridge.publish).toHaveBeenCalledTimes(2);
        expect(bridge.publish).toHaveBeenCalledWith(
            'queuebox-events',
            toPubSubMessage('queuebox-events', 'publisher-1', entry),
        );
        expect(bridge.publish).toHaveBeenCalledWith(
            'queuebox-events',
            toPubSubMessage('queuebox-events', 'publisher-1', entry, { delivery: 'key' }),
        );
        expect(bridge.subscribe).toHaveBeenCalledWith(
            'queuebox-events',
            expect.any(Function),
        );
        expect(sendToTargetsWithResult).toHaveBeenCalledWith({});
    });

    it('keeps full-entry delivery as the default pub/sub envelope', () => {
        const entry = createWsEntry();

        expect(toPubSubMessage('queuebox-events', 'publisher-1', entry)).toEqual({
            key: entry.key,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            typeId: entry.typeId,
            delivery: 'entry',
            payload: entry.resource,
        });
    });

    it('can build key-only envelopes without embedding the queue payload', () => {
        const entry = createWsEntry();
        const message = toPubSubMessage(
            'queuebox-events',
            'publisher-1',
            entry,
            { delivery: 'key' },
        );

        expect(message).toEqual({
            key: entry.key,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            typeId: entry.typeId,
            delivery: 'key',
        });
        expect(JSON.stringify(message)).not.toContain(entry.resource);
    });

    it('enqueues subscribed messages into the local inbox', async () => {
        const bridge = createBridge();
        const enqueueIfAbsent = vi.fn(async (entry: ResourceEntry) => entry);
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onOutboxClusterPublishDo: vi.fn().mockReturnThis(),
            inbox: {
                enqueueIfAbsent,
            },
        } as unknown as WsQueueBoxServerService;

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
        });

        const entry = createWsEntry();
        await bridge.subscriber?.(
            toPubSubMessage('queuebox-events', 'publisher-2', entry),
        );

        expect(enqueueIfAbsent).toHaveBeenCalledTimes(1);
        expect(enqueueIfAbsent.mock.calls[0][0]).toMatchObject({
            key: entry.key,
            typeId: entry.typeId,
            resource: entry.resource,
        });
    });

    it('loads durable queue entries before enqueuing key-only subscribed messages', async () => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const enqueueIfAbsent = vi.fn(async (entry: ResourceEntry) => entry);
        const getItem = vi.fn(async () => entry);
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onOutboxClusterPublishDo: vi.fn().mockReturnThis(),
            inbox: {
                enqueueIfAbsent,
                getItem,
            },
        } as unknown as WsQueueBoxServerService;

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event),
        });

        await bridge.subscriber?.(
            toPubSubMessage(
                'queuebox-events',
                'publisher-2',
                entry,
                { delivery: 'key' },
            ),
        );

        expect(getItem).toHaveBeenCalledWith(entry.key);
        expect(enqueueIfAbsent).toHaveBeenCalledWith(entry);
        const receiveEvent = timingEvents.find(
            (event) => event.operation === 'cluster-receive',
        );
        expect(receiveEvent).toMatchObject({
            component: 'queuebox-pubsub',
            operation: 'cluster-receive',
            status: 'ok',
            details: {
                channel: 'queuebox-events',
                delivery: 'key',
                entryKind: 'ws-inbox',
            },
        });
        expect(Object.keys(receiveEvent?.details ?? {}).sort()).toEqual([
            'channel',
            'delivery',
            'entryKind',
        ]);
    });

    it('drops missing durable key-only messages with timing details', async () => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const enqueueIfAbsent = vi.fn(async (entry: ResourceEntry) => entry);
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onOutboxClusterPublishDo: vi.fn().mockReturnThis(),
            inbox: {
                enqueueIfAbsent,
                getItem: vi.fn(async () => undefined),
            },
        } as unknown as WsQueueBoxServerService;

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event),
        });

        await bridge.subscriber?.(
            toPubSubMessage(
                'queuebox-events',
                'publisher-2',
                entry,
                { delivery: 'key' },
            ),
        );

        expect(enqueueIfAbsent).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(
            expect.objectContaining({
                component: 'queuebox-pubsub',
                operation: 'key-load-miss',
                status: 'ok',
                details: expect.objectContaining({
                    channel: 'queuebox-events',
                    resourceId: entry.key.resourceId,
                }),
            }),
        );
    });

    it('drops a durable key load whose identity differs from its envelope', async () => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const enqueueIfAbsent = vi.fn();
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onOutboxClusterPublishDo: vi.fn().mockReturnThis(),
            inbox: {
                enqueueIfAbsent,
                getItem: vi.fn(async () => ({
                    ...entry,
                    key: { ...entry.key, resourceId: 'different-resource' },
                })),
            },
        } as unknown as WsQueueBoxServerService;
        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event),
        });

        await bridge.subscriber?.(
            toPubSubMessage('queuebox-events', 'publisher-2', entry, {
                delivery: 'key',
            }),
        );

        expect(enqueueIfAbsent).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(expect.objectContaining({
            operation: 'key-load-mismatch',
            details: expect.objectContaining({ resourceId: entry.key.resourceId }),
        }));
    });

    it('drops malformed envelopes with timing details instead of enqueueing them', async () => {
        const bridge = createBridge();
        const timingEvents: RallarTimingEvent[] = [];
        const enqueueIfAbsent = vi.fn(async (entry: ResourceEntry) => entry);
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onOutboxClusterPublishDo: vi.fn().mockReturnThis(),
            inbox: {
                enqueueIfAbsent,
                getItem: vi.fn(),
            },
        } as unknown as WsQueueBoxServerService;

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event),
        });

        await bridge.subscriber?.({
            channel: 'queuebox-events',
            publisherId: 'publisher-2',
            typeId: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
            delivery: 'entry',
            payload: JSON.stringify({ ok: true }),
        } as QueueBoxPubSubMessage);

        expect(enqueueIfAbsent).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(expect.objectContaining({
            component: 'queuebox-pubsub',
            operation: 'drop-malformed',
            status: 'ok',
        }));
    });

    it('preserves raw queue payloads when subscribed messages are not AL messages', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const resourceEntry = toResourceEntryFromPubSubMessage(
            {
                key: {
                    topicId: 'custom',
                    resourceId: 'resource-1',
                    contextId: 'ctx-1',
                },
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                typeId: 'custom.type.v1',
                payload: '{"hello":"world"}',
            },
        );

        expect(resourceEntry.resource).toBe('{"hello":"world"}');
        expect(resourceEntry.key).toEqual({
            topicId: 'custom',
            resourceId: 'resource-1',
            contextId: 'ctx-1',
        });
        expect(resourceEntry.typeId).toBe('custom.type.v1');
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to parse published payload as ALMessage'),
            expect.any(TypeError),
        );
        warn.mockRestore();
    });
});

function createBridge(): QueueBoxPubSubBridge & {
    publish: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    subscriber?: Parameters<QueueBoxPubSubBridge['subscribe']>[1];
} {
    let subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;
    const publish = vi.fn(
        async (_channel: string, _message: QueueBoxPubSubMessage) => undefined,
    );
    const subscribe = vi.fn(
        async (
            _channel: string,
            onMessage: Parameters<QueueBoxPubSubBridge['subscribe']>[1],
        ) => {
            subscriber = onMessage;
        },
    );

    return {
        publish,
        subscribe,
        get subscriber() {
            return subscriber;
        },
    };
}

function createWsEntry(): ResourceEntry {
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Ship bridge' },
        ),
        WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
    );
}

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve(): void;
}> {
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });

    return {
        promise,
        resolve: () => resolvePromise(),
    };
}

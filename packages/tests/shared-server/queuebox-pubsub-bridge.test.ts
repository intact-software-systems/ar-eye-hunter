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

describe('QueueBoxPubSubBridge', () => {
    it('publishes all inbox and outbox entries through the supplied bridge', async () => {
        const inboxCallbacks: QueueMessageCallback[] = [];
        const outboxCallbacks: QueueMessageCallback[] = [];
        const bridge = createBridge();
        const wsQBoxServerService = {
            onAllInboxMessagesDo(callback: QueueMessageCallback) {
                inboxCallbacks.push(callback);
                return this;
            },
            onAllOutboxMessagesDo(callback: QueueMessageCallback) {
                outboxCallbacks.push(callback);
                return this;
            },
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
        await outboxCallbacks[0].onMessage({}, entry, {});

        expect(bridge.publish).toHaveBeenCalledTimes(2);
        expect(bridge.publish).toHaveBeenCalledWith(
            'queuebox-events',
            toPubSubMessage('queuebox-events', 'publisher-1', entry),
        );
        expect(bridge.subscribe).toHaveBeenCalledWith(
            'queuebox-events',
            expect.any(Function),
        );
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
            onAllOutboxMessagesDo: vi.fn().mockReturnThis(),
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
        const enqueueIfAbsent = vi.fn(async (entry: ResourceEntry) => entry);
        const getItem = vi.fn(async () => entry);
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onAllOutboxMessagesDo: vi.fn().mockReturnThis(),
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
    });

    it('drops missing durable key-only messages with timing details', async () => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const enqueueIfAbsent = vi.fn(async (entry: ResourceEntry) => entry);
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onAllOutboxMessagesDo: vi.fn().mockReturnThis(),
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
        expect(timingEvents).toEqual([
            expect.objectContaining({
                component: 'queuebox-pubsub',
                operation: 'key-load-miss',
                status: 'ok',
                details: expect.objectContaining({
                    channel: 'queuebox-events',
                    resourceId: entry.key.resourceId,
                }),
            }),
        ]);
    });

    it('drops malformed envelopes with timing details instead of enqueueing them', async () => {
        const bridge = createBridge();
        const timingEvents: RallarTimingEvent[] = [];
        const enqueueIfAbsent = vi.fn(async (entry: ResourceEntry) => entry);
        const wsQBoxServerService = {
            onAllInboxMessagesDo: vi.fn().mockReturnThis(),
            onAllOutboxMessagesDo: vi.fn().mockReturnThis(),
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
        expect(timingEvents).toEqual([
            expect.objectContaining({
                component: 'queuebox-pubsub',
                operation: 'drop-malformed',
                status: 'ok',
            }),
        ]);
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

import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import {
    installQueueBoxPubSubBridge,
    toPubSubMessage,
    type QueueBoxPubSubWsService
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { describe, expect, it, vi } from 'vitest';

type ClusterPublisher = Parameters<QueueBoxPubSubWsService['onOutboxClusterPublishDo']>[0];

interface TestQueueBoxPubSubBridge extends QueueBoxPubSubBridge {
    readonly published: PublishedQueueMessage[];
    readonly subscribedChannels: string[];
    readonly subscriber?: Parameters<QueueBoxPubSubBridge['subscribe']>[1];
}

interface PublishedQueueMessage {
    readonly channel: string;
    readonly message: QueueBoxPubSubMessage;
}

describe('QueueBoxPubSubBridge', () => {
    it('exposes the actual transport subscription as readiness', async () => {
        const subscription = Promise.withResolvers<void>();
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

    it('publishes a durable outbox key and sends the message to local recipients', async () => {
        const outboxPublishers: ClusterPublisher[] = [];
        const bridge = createBridge();
        const deliveredMessages: ALMessage[] = [];
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({
            registerOutboxPublisher: (publisher) => outboxPublishers.push(publisher),
            sendToTargetsWithResult: (message) => {
                deliveredMessages.push(message);
                return sentLiveResult(message);
            }
        });

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1'
        });
        const entry = createWsOutboxEntry();

        const message = decodePersistedALMessage(entry.resource);
        await outboxPublishers[0](message, entry);

        expect(bridge.published).toEqual([
            {
                channel: 'queuebox-events',
                message: {
                    key: entry.key,
                    channel: 'queuebox-events',
                    publisherId: 'publisher-1',
                    typeId: EnqueuedType.WS_OUTBOX,
                    delivery: 'key'
                }
            }
        ]);
        expect(bridge.subscribedChannels).toEqual(['queuebox-events']);
        expect(deliveredMessages).toEqual([message]);
    });

    it('rejects publication of entries outside the durable WS outbox', () => {
        const entry = createWsEntry();

        expect(() =>
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-1',
                entry
            })
        ).toThrow('QueueBox cluster notifications require admitted WS outbox work');
    });

    it('can build key-only envelopes without embedding the queue payload', () => {
        const entry = createWsOutboxEntry();
        const message = toPubSubMessage({
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            entry
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

    it('loads durable outbox work before sending subscribed messages', async () => {
        const bridge = createBridge();
        const entry = createWsOutboxEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const outbox = new InMemoryQueueBox();
        await outbox.enqueue(entry);
        const delivered: ALMessage[] = [];
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({
            outbox,
            sendToTargetsWithResult: (message) => {
                delivered.push(message);
                return sentLiveResult(message);
            }
        });

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
                entry
            })
        );

        expect(delivered).toEqual([decodePersistedALMessage(entry.resource)]);
        expect(await outbox.getAllKeys()).toEqual([entry.key]);
        expect((await outbox.getItem(entry.key))?.dequeueAudit.attempts).toBe(0);
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
                entryKind: 'ws-outbox'
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
        const validatedOutboxEntries: ResourceEntry[] = [];
        const deliveredMessages: ALMessage[] = [];
        const outbox = new InMemoryQueueBox();
        vi.spyOn(outbox, 'getItem').mockResolvedValue(entry);
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({
            outbox,
            sendToTargetsWithResult: (message) => {
                deliveredMessages.push(message);
                return noRecipientLiveSendResult(message);
            }
        });
        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            onValidatedOutboxKeyReceived: (validatedEntry) => {
                validatedOutboxEntries.push(validatedEntry);
            }
        });

        await bridge.subscriber?.(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry
            })
        );
        await bridge.subscriber?.({
            ...toPubSubMessage({ channel: 'queuebox-events', publisherId: 'publisher-2', entry }),
            delivery: 'entry',
            payload: entry.resource
        });

        expect(validatedOutboxEntries).toEqual([entry]);
        expect(deliveredMessages).toEqual([
            decodePersistedALMessage(entry.resource)
        ]);
    });

    it('drops missing durable key-only messages with timing details', async () => {
        const bridge = createBridge();
        const entry = createWsOutboxEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const outbox = new InMemoryQueueBox();
        const sendToTargetsWithResult = vi.fn(sentLiveResult);
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult });

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
                entry
            })
        );

        expect(sendToTargetsWithResult).not.toHaveBeenCalled();
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
        const entry = createWsOutboxEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const outbox = new InMemoryQueueBox();
        vi.spyOn(outbox, 'getItem').mockResolvedValue({
            ...entry,
            key: { ...entry.key, resourceId: 'different-resource' }
        });
        const sendToTargetsWithResult = vi.fn(sentLiveResult);
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult });
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
                entry
            })
        );

        expect(sendToTargetsWithResult).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(expect.objectContaining({
            operation: 'key-load-mismatch',
            details: expect.objectContaining({ resourceId: entry.key.resourceId })
        }));
    });

    it.each(['entry', 'key'])('rejects inbox %s notifications before loading or sending', async (delivery) => {
        const bridge = createBridge();
        const entry = createWsEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const outbox = new InMemoryQueueBox();
        const read = vi.spyOn(outbox, 'getItem');
        const sendToTargetsWithResult = vi.fn(sentLiveResult);
        const wsQBoxServerService = createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult });

        installQueueBoxPubSubBridge({
            wsQBoxServerService,
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            timing: (event) => timingEvents.push(event)
        });

        await bridge.subscriber?.({
            key: entry.key,
            channel: 'queuebox-events',
            publisherId: 'publisher-2',
            typeId: EnqueuedType.WS_INBOX,
            delivery,
            ...(delivery === 'entry' ? { payload: entry.resource } : {})
        });

        expect(read).not.toHaveBeenCalled();
        expect(sendToTargetsWithResult).not.toHaveBeenCalled();
        expect(timingEvents).toContainEqual(expect.objectContaining({
            component: 'queuebox-pubsub',
            operation: 'drop-malformed',
            status: 'ok'
        }));
    });

    it('rejects durable outbox work whose retained payload is not an AL message', async () => {
        const bridge = createBridge();
        const outbox = new InMemoryQueueBox();
        const entry = { ...createWsOutboxEntry(), resource: '{"hello":"world"}' };
        await outbox.enqueue(entry);
        const sendToTargetsWithResult = vi.fn(sentLiveResult);
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult }),
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1'
        });

        await expect(bridge.subscriber!(toPubSubMessage({
            channel: 'queuebox-events',
            publisherId: 'publisher-2',
            entry
        }))).rejects.toThrow();
        expect(sendToTargetsWithResult).not.toHaveBeenCalled();
    });
});

function createBridge(): TestQueueBoxPubSubBridge {
    let subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;
    const published: TestQueueBoxPubSubBridge['published'] = [];
    const subscribedChannels: string[] = [];

    return {
        published,
        subscribedChannels,
        publish: async (channel, message) => {
            published.push({ channel, message });
        },
        subscribe: async (channel, onMessage) => {
            subscribedChannels.push(channel);
            subscriber = onMessage;
        },
        get subscriber() {
            return subscriber;
        }
    };
}

interface CreateTestQueueBoxPubSubWsServiceInput {
    readonly outbox?: InMemoryQueueBox;
    readonly registerOutboxPublisher?: (publisher: ClusterPublisher) => void;
    readonly sendToTargetsWithResult?: (
        message: ALMessage
    ) => WsServerLiveSendResult;
}

function createTestQueueBoxPubSubWsService(
    input: CreateTestQueueBoxPubSubWsServiceInput = {}
): QueueBoxPubSubWsService {
    const service: QueueBoxPubSubWsService = {
        outbox: input.outbox ?? new InMemoryQueueBox(),
        onOutboxClusterPublishDo(publisher) {
            input.registerOutboxPublisher?.(publisher);
            return service;
        },
        sendToTargetsWithResult(message) {
            return input.sendToTargetsWithResult?.(message) ?? noRecipientLiveSendResult(message);
        }
    };

    return service;
}

function sentLiveResult(message: ALMessage): WsServerLiveSendResult {
    const recipient = { peerId: 'peer-1', connectionId: 'connection-1' };
    return {
        status: 'sent-live',
        message,
        recipients: [recipient],
        recipientCount: 1,
        sentCount: 1,
        failedCount: 0,
        failures: []
    };
}

function noRecipientLiveSendResult(message: ALMessage): WsServerLiveSendResult {
    return {
        status: 'no-recipients',
        message,
        recipients: [],
        recipientCount: 0,
        sentCount: 0,
        failedCount: 0,
        failures: []
    };
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

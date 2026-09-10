import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import {
    installQueueBoxPubSubBridge,
    toPubSubMessage,
    type QueueBoxPubSubWsService
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundIdentityEntry,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

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
                    delivery: 'key',
                    expiresAtMs: decodePersistedALMessage(entry.resource).constraints?.expiresAtMs
                }
            }
        ]);
        expect(bridge.subscribedChannels).toEqual(['queuebox-events']);
        expect(deliveredMessages).toEqual([message]);
    });

    it('keeps long valid AL identities in storage while publishing bounded advisory claims', async () => {
        const original = createWsOutboxEntry();
        const message = decodePersistedALMessage(original.resource);
        const longMessage = { ...message, id: { ...message.id, msgId: 'm'.repeat(10_000), senderId: 's'.repeat(10_000) } };
        const entry = { ...original, resource: JSON.stringify(longMessage) };
        const outbox = new InMemoryQueueBox();
        await persistCanonicalEntry(outbox, entry);
        const bridge = createBridge();
        const delivered: ALMessage[] = [];
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: createTestQueueBoxPubSubWsService({
                outbox,
                sendToTargetsWithResult: (msg) => {
                    delivered.push(msg);
                    return sentLiveResult(msg);
                }
            }),
            bridge,
            channel: 'queuebox-events',
            publisherId: 'local'
        });
        const notice = toPubSubMessage({ channel: 'queuebox-events', publisherId: 'remote', entry });
        expect(new TextEncoder().encode(JSON.stringify(notice)).length).toBeLessThan(8_000);
        expect(JSON.stringify(notice)).not.toContain(longMessage.id.msgId);
        await bridge.subscriber?.(notice);
        expect(delivered).toEqual([longMessage]);
    });

    it('does not wake topology or send when loading the identity fact crosses the claimed deadline', async () => {
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        let nowMs = Date.now();
        const entry = createWsOutboxEntry();
        const outbox = new InMemoryQueueBox();
        await persistCanonicalEntry(outbox, entry);
        const bridge = createBridge();
        const send = vi.fn(sentLiveResult);
        const wake = vi.fn();
        await installQueueBoxPubSubBridge({
            clock: { nowMs: () => nowMs },
            wsQBoxServerService: createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult: send }),
            bridge,
            channel: 'queuebox-events',
            publisherId: 'local',
            onValidatedOutboxKeyReceived: wake
        });
        const notice = toPubSubMessage({ channel: 'queuebox-events', publisherId: 'remote', entry });
        const getItem = outbox.getItem.bind(outbox);
        vi.spyOn(outbox, 'getItem').mockImplementation(async (key) => {
            if (key.topicId === 'AL_OUTBOUND_IDENTITY') {
                nowMs = notice.expiresAtMs;
            }
            return await getItem(key);
        });
        await expect(bridge.subscriber!(notice)).resolves.toBeUndefined();
        expect(wake).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it('rejects malformed and oversized notices before loading canonical storage', async () => {
        const entry = createWsOutboxEntry();
        const notice = toPubSubMessage({ channel: 'queuebox-events', publisherId: 'remote', entry });
        const outbox = new InMemoryQueueBox();
        const read = vi.spyOn(outbox, 'getItem');
        const bridge = createBridge();
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: createTestQueueBoxPubSubWsService({ outbox }),
            bridge,
            channel: 'queuebox-events',
            publisherId: 'local'
        });
        for (
            const malformed of [
                { ...notice, key: { ...notice.key, topicId: 't'.repeat(37) } },
                { ...notice, key: { ...notice.key, resourceId: 'r'.repeat(129) } },
                { ...notice, key: { ...notice.key, contextId: 'c'.repeat(129) } },
                { ...notice, publisherId: 'p'.repeat(8_000) },
                { ...notice, expiresAtMs: 1.5 }
            ]
        ) {
            await bridge.subscriber?.(malformed);
        }
        expect(read).not.toHaveBeenCalled();
    });

    it.each(['missing', 'malformed-json', 'malformed-provenance'] as const)(
        'rejects a %s live identity fact before topology wake or delivery',
        async (corruption) => {
            const entry = createWsOutboxEntry();
            const outbox = new InMemoryQueueBox();
            await outbox.enqueue(entry);
            if (corruption !== 'missing') {
                const reference = toALOutboundMessageReference('cluster-test', entry, decodePersistedALMessage(entry.resource));
                const identity = toALOutboundIdentityEntry(reference, entry, captureALOutboundCreationExpiry(decodePersistedALMessage(entry.resource)));
                await outbox.enqueue({
                    ...identity,
                    resource: corruption === 'malformed-json' ? '{' : JSON.stringify({ reference, creationExpiry: 'invalid' })
                });
            }
            const bridge = createBridge();
            const wake = vi.fn();
            const send = vi.fn(sentLiveResult);
            await installQueueBoxPubSubBridge({
                wsQBoxServerService: createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult: send }),
                bridge,
                channel: 'queuebox-events',
                publisherId: 'local',
                onValidatedOutboxKeyReceived: wake
            });
            await expect(bridge.subscriber!(toPubSubMessage({ channel: 'queuebox-events', publisherId: 'remote', entry })))
                .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
            expect(wake).not.toHaveBeenCalled();
            expect(send).not.toHaveBeenCalled();
        }
    );

    it('does not dispatch an expired notice for a later incarnation at the same physical key', async () => {
        const original = createWsOutboxEntry();
        const originalMessage = decodePersistedALMessage(original.resource);
        const expiredMessage = { ...originalMessage, constraints: { expiresAtMs: Date.now() - 1 } };
        const expiredEntry = { ...original, resource: JSON.stringify(expiredMessage) };
        const notice = toPubSubMessage({ channel: 'queuebox-events', publisherId: 'remote', entry: expiredEntry });
        const outbox = new InMemoryQueueBox();
        await persistCanonicalEntry(outbox, original);
        const load = vi.spyOn(outbox, 'getItem');
        const bridge = createBridge();
        const send = vi.fn(sentLiveResult);
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult: send }),
            bridge,
            channel: 'queuebox-events',
            publisherId: 'local'
        });
        await expect(bridge.subscriber!(notice)).resolves.toBeUndefined();
        expect(load).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
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
            delivery: 'key',
            expiresAtMs: decodePersistedALMessage(entry.resource).constraints?.expiresAtMs
        });
        expect(JSON.stringify(message)).not.toContain(entry.resource);
    });

    it('loads durable outbox work before sending subscribed messages', async () => {
        const bridge = createBridge();
        const entry = createWsOutboxEntry();
        const timingEvents: RallarTimingEvent[] = [];
        const outbox = new InMemoryQueueBox();
        await persistCanonicalEntry(outbox, entry);
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
        expect(await outbox.getAllKeys()).toHaveLength(2);
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

    it('announces a requeued row as an external write, because the requeue runs outside every runtime', async () => {
        const bridge = createBridge();
        // A remote process reserved the row; delivery on this one is what fails below.
        const entry = { ...createWsOutboxEntry(), status: EntityStatus.RESERVED };
        const outbox = new InMemoryQueueBox();
        await persistCanonicalEntry(outbox, entry);
        const wakeQueueEngine = vi.fn();
        installQueueBoxPubSubBridge({
            wsQBoxServerService: createTestQueueBoxPubSubWsService({
                outbox,
                sendToTargetsWithResult: failedLiveSendResult
            }),
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1',
            wakeQueueEngine
        });

        await bridge.subscriber?.(
            toPubSubMessage({ channel: 'queuebox-events', publisherId: 'publisher-2', entry })
        );

        // The row is back in the queue and the owner that must claim it learns of it only from here.
        expect((await outbox.getItem(entry.key))?.status).toBe(EntityStatus.RETRY);
        expect(wakeQueueEngine).toHaveBeenCalledOnce();
    });

    it('reports only exact durable outbox key receives through the optional wake seam', async () => {
        const bridge = createBridge();
        const entry = createWsOutboxEntry();
        const validatedOutboxEntries: ResourceEntry[] = [];
        const deliveredMessages: ALMessage[] = [];
        const outbox = new InMemoryQueueBox();
        await persistCanonicalEntry(outbox, entry);
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

    it('rejects missing live durable key-only messages with timing details', async () => {
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

        await expect(bridge.subscriber!(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry
            })
        )).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

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

        await expect(bridge.subscriber!(
            toPubSubMessage({
                channel: 'queuebox-events',
                publisherId: 'publisher-2',
                entry
            })
        )).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

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
        const valid = createWsOutboxEntry();
        const notice = toPubSubMessage({ channel: 'queuebox-events', publisherId: 'publisher-2', entry: valid });
        const entry = { ...valid, resource: '{"hello":"world"}' };
        await outbox.enqueue(entry);
        const sendToTargetsWithResult = vi.fn(sentLiveResult);
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: createTestQueueBoxPubSubWsService({ outbox, sendToTargetsWithResult }),
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1'
        });

        await expect(bridge.subscriber!(notice)).rejects.toThrow();
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

function failedLiveSendResult(message: ALMessage): WsServerLiveSendResult {
    const recipient = { peerId: 'peer-1', connectionId: 'connection-1' };
    return {
        status: 'sent-live',
        message,
        recipients: [recipient],
        recipientCount: 1,
        sentCount: 0,
        failedCount: 1,
        failures: [recipient]
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
                ttlMs: 60_000,
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

async function persistCanonicalEntry(outbox: InMemoryQueueBox, entry: ResourceEntry): Promise<void> {
    await outbox.enqueue(entry);
    await outbox.enqueue(toALOutboundIdentityEntry(
        toALOutboundMessageReference('cluster-test', entry, decodePersistedALMessage(entry.resource)),
        entry,
        captureALOutboundCreationExpiry(decodePersistedALMessage(entry.resource))
    ));
}

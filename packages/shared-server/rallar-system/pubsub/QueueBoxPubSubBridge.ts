import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isKeysEqual, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    type ResourceInboxRetryPolicy,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink,
} from '../services/timing.ts';
import { requeueRemoteWsOutboxDeliveryFailure } from './RemoteWsOutboxDeliveryFailure.ts';
import {
    isValidQueueBoxPubSubMessage,
    type QueueBoxPubSubBridge,
    type QueueBoxPubSubDelivery,
    type QueueBoxPubSubMessage,
    type QueueBoxPubSubMessageKey,
} from './queuebox-pubsub-contracts.ts';
import { toResourceEntryFromPubSubMessage } from './to-resource-entry-from-pub-sub-message.ts';

export {
    type QueueBoxPubSubBridge,
    type QueueBoxPubSubDelivery,
    type QueueBoxPubSubEntryMessage,
    type QueueBoxPubSubKeyMessage,
    type QueueBoxPubSubMessage,
    type QueueBoxPubSubMessageKey,
} from './queuebox-pubsub-contracts.ts';
export { toResourceEntryFromPubSubMessage } from './to-resource-entry-from-pub-sub-message.ts';

export type InstallQueueBoxPubSubBridgeOptions = Readonly<{
    wsQBoxServerService: WsQueueBoxServerService;
    bridge: QueueBoxPubSubBridge;
    channel: string;
    publisherId: string;
    delivery?: QueueBoxPubSubDelivery;
    timing?: RallarTimingSink;
    retryPolicy?: ResourceInboxRetryPolicy;
    jitterUnit?: () => number;
    onValidatedOutboxKeyReceived?: (entry: ResourceEntry) => void;
}>;

export function installQueueBoxPubSubBridge(
    options: InstallQueueBoxPubSubBridgeOptions,
): Promise<void> {
    const {
        wsQBoxServerService,
        bridge,
        channel,
        publisherId,
        delivery = 'entry',
        timing,
        retryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
        jitterUnit = Math.random,
    } = options;

    registerQueueBoxInboxPublisher({
        wsQBoxServerService,
        bridge,
        channel,
        publisherId,
        delivery,
    });
    registerQueueBoxOutboxPublisher({
        wsQBoxServerService,
        bridge,
        channel,
        publisherId,
        timing,
    });
    const readiness = timeRallarAsync(
        timing,
        {
            component: 'queuebox-pubsub',
            operation: 'listener-subscribe',
            details: { channel },
        },
        async () => {
            await bridge.subscribe(channel, async (message) => {
                await receiveQueueBoxPubSubMessage(message, {
                    wsQBoxServerService,
                    channel,
                    publisherId,
                    timing,
                    retryPolicy,
                    jitterUnit,
                    onValidatedOutboxKeyReceived:
                        options.onValidatedOutboxKeyReceived,
                });
            });
        },
    );
    void readiness.catch((error) => {
        console.error('QueueBox pub/sub bridge listener failed:', error);
    });

    return readiness;
}

function registerQueueBoxInboxPublisher(
    options: Readonly<{
        wsQBoxServerService: WsQueueBoxServerService;
        bridge: QueueBoxPubSubBridge;
        channel: string;
        publisherId: string;
        delivery: QueueBoxPubSubDelivery;
    }>,
): void {
    options.wsQBoxServerService.onAllInboxMessagesDo({
        onMessage: async (_, entry: ResourceEntry, __) => {
            await options.bridge.publish(
                options.channel,
                toPubSubMessage(
                    options.channel,
                    options.publisherId,
                    entry,
                    { delivery: options.delivery },
                ),
            );
        },
    });
}

function registerQueueBoxOutboxPublisher(
    options: Readonly<{
        wsQBoxServerService: WsQueueBoxServerService;
        bridge: QueueBoxPubSubBridge;
        channel: string;
        publisherId: string;
        timing?: RallarTimingSink;
    }>,
): void {
    options.wsQBoxServerService.onOutboxClusterPublishDo(async (message, entry) => {
        const envelope = toPubSubMessage(
            options.channel,
            options.publisherId,
            entry,
            { delivery: 'key' },
        );
        await options.bridge.publish(
            options.channel,
            envelope,
        );
        recordPubSubTiming(options.timing, 'outbox-cluster-publish', envelope);
        const result = options.wsQBoxServerService.sendToTargetsWithResult(message);
        recordPubSubTiming(options.timing, 'outbox-direct-send', envelope, {
            localPublisherId: options.publisherId,
            deliveryStatus: result.status,
            recipientCount: result.recipientCount,
            sentCount: result.sentCount,
            failedCount: result.failedCount,
        });
        if (result.failedCount > 0) {
            throw new Error(`Failed ${result.failedCount} local WS outbox sends`);
        }
    });
}

async function receiveQueueBoxPubSubMessage(
    message: QueueBoxPubSubMessage,
    options: Readonly<{
        wsQBoxServerService: WsQueueBoxServerService;
        channel: string;
        publisherId: string;
        timing?: RallarTimingSink;
        retryPolicy: ResourceInboxRetryPolicy;
        jitterUnit: () => number;
        onValidatedOutboxKeyReceived?: (entry: ResourceEntry) => void;
    }>,
): Promise<void> {
    if (
        message.typeId === WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE &&
        message.publisherId === options.publisherId
    ) {
        return;
    }
    recordRallarTiming(
        options.timing,
        {
            component: 'queuebox-pubsub',
            operation: 'cluster-receive',
            details: {
                channel: options.channel,
                delivery: message.delivery ?? 'entry',
                entryKind: toQueueBoxPubSubEntryKind(message.typeId),
            },
        },
        'ok',
        0,
    );
    const entry = await resolveResourceEntryFromPubSubMessage(message, {
        expectedChannel: options.channel,
        loadByKey: async (key) => await (
            message.typeId === WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE
                ? options.wsQBoxServerService.outbox
                : options.wsQBoxServerService.inbox
        ).getItem(key),
        timing: options.timing,
    });
    if (!entry) {
        return;
    }
    if (entry.typeId === WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE) {
        if (message.delivery === 'key') {
            notifyValidatedOutboxKey(
                entry,
                options.onValidatedOutboxKeyReceived,
            );
        }
        await sendRemoteQueueBoxOutboxEntry(message, entry, {
            wsQBoxServerService: options.wsQBoxServerService,
            publisherId: options.publisherId,
            timing: options.timing,
            retryPolicy: options.retryPolicy,
            jitterUnit: options.jitterUnit,
        });
        return;
    }

    await options.wsQBoxServerService.inbox.enqueueIfAbsent(entry);
}

function notifyValidatedOutboxKey(
    entry: ResourceEntry,
    callback: ((entry: ResourceEntry) => void) | undefined,
): void {
    try {
        callback?.(entry);
    } catch (error) {
        console.error('QueueBox validated outbox-key callback failed:', error);
    }
}

async function sendRemoteQueueBoxOutboxEntry(
    message: QueueBoxPubSubMessage,
    entry: ResourceEntry,
    options: Readonly<{
        wsQBoxServerService: WsQueueBoxServerService;
        publisherId: string;
        timing?: RallarTimingSink;
        retryPolicy: ResourceInboxRetryPolicy;
        jitterUnit: () => number;
    }>,
): Promise<void> {
    const result = options.wsQBoxServerService.sendToTargetsWithResult(
        JSON.parse(entry.resource) as ALMessage,
    );
    recordPubSubTiming(options.timing, 'outbox-direct-send', message, {
        localPublisherId: options.publisherId,
        deliveryStatus: result.status,
        recipientCount: result.recipientCount,
        sentCount: result.sentCount,
        failedCount: result.failedCount,
    });
    if (result.failedCount === 0) {
        return;
    }

    const requeued = await requeueRemoteWsOutboxDeliveryFailure(
        options.wsQBoxServerService.outbox,
        entry,
        {
            retryPolicy: options.retryPolicy,
            jitterUnit: options.jitterUnit,
        },
    );
    recordPubSubTiming(
        options.timing,
        'outbox-remote-send-failed',
        message,
        {
            localPublisherId: options.publisherId,
            recipientCount: result.recipientCount,
            failedCount: result.failedCount,
            durableStatus: requeued?.status ?? 'stale',
            reservationAttempt: entry.dequeueAudit.attempts,
        },
    );
}

function toQueueBoxPubSubEntryKind(typeId: string): string {
    if (typeId === WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE) {
        return 'ws-outbox';
    }
    if (typeId === WsQueueBoxServerService.INBOX_ENQUEUE_TYPE) {
        return 'ws-inbox';
    }

    return 'other';
}

export function toPubSubMessage(
    channel: string,
    publisherId: string,
    entry: ResourceEntry,
    options: Readonly<{
        delivery?: QueueBoxPubSubDelivery;
    }> = {},
): QueueBoxPubSubMessage {
    if (options.delivery === 'key') {
        return {
            key: entry.key,
            channel,
            publisherId,
            typeId: entry.typeId,
            delivery: 'key',
        };
    }

    return {
        key: entry.key,
        channel,
        publisherId,
        typeId: entry.typeId,
        delivery: 'entry',
        payload: entry.resource,
    };
}

async function resolveResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubMessage,
    options: Readonly<{
        expectedChannel: string;
        loadByKey: (key: QueueBoxPubSubMessageKey) => Promise<ResourceEntry | undefined>;
        timing?: RallarTimingSink;
    }>,
): Promise<ResourceEntry | undefined> {
    if (!isValidQueueBoxPubSubMessage(message, options.expectedChannel)) {
        recordPubSubTiming(options.timing, 'drop-malformed', message);
        return undefined;
    }

    if (message.delivery === 'key') {
        const entry = await options.loadByKey(message.key);
        if (!entry) {
            recordPubSubTiming(options.timing, 'key-load-miss', message);
            return undefined;
        }
        if (!isKeysEqual(entry.key, message.key) || entry.typeId !== message.typeId) {
            recordPubSubTiming(options.timing, 'key-load-mismatch', message);
            return undefined;
        }
        recordPubSubTiming(options.timing, 'outbox-key-loaded', message);

        return entry;
    }

    return toResourceEntryFromPubSubMessage(message);
}

function recordPubSubTiming(
    timing: RallarTimingSink | undefined,
    operation: string,
    message: Partial<QueueBoxPubSubMessage> | undefined,
    details: RallarTimingDetails = {},
): void {
    recordRallarTiming(
        timing,
        {
            component: 'queuebox-pubsub',
            operation,
            serviceId: message?.publisherId,
            details: { ...toPubSubTimingDetails(message), ...details },
        },
        'ok',
        0,
    );
}

function toPubSubTimingDetails(
    message: Partial<QueueBoxPubSubMessage> | undefined,
): RallarTimingDetails {
    return {
        channel: message?.channel,
        delivery: message?.delivery,
        topicId: message?.key?.topicId,
        resourceId: message?.key?.resourceId,
        contextId: message?.key?.contextId,
        typeId: message?.typeId,
    };
}

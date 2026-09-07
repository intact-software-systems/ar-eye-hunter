import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    type ResourceInboxRetryPolicy
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../observability/timing.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    decodeQueueBoxPubSubMessage,
    type QueueBoxPubSubBridge,
    type QueueBoxPubSubMessage,
    type QueueBoxPubSubMessageKey
} from './queue-box-pub-sub-contracts.ts';
import { requeueRemoteWsOutboxDeliveryFailure } from './requeue-remote-ws-outbox-delivery-failure.ts';

export interface QueueBoxPubSubWsService {
    readonly outbox: QueueBoxResourceEntryRepository;
    onOutboxClusterPublishDo(
        publisher: (message: ALMessage, entry: ResourceEntry) => Promise<void>
    ): QueueBoxPubSubWsService;
    sendToTargetsWithResult(message: ALMessage): WsServerLiveSendResult;
}

export interface InstallQueueBoxPubSubBridgeOptions {
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly bridge: QueueBoxPubSubBridge;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy?: ResourceInboxRetryPolicy;
    readonly jitterUnit?: () => number;
    readonly onValidatedOutboxKeyReceived?: (entry: ResourceEntry) => void;
}

interface RegisterQueueBoxOutboxPublisherInput {
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly bridge: QueueBoxPubSubBridge;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
}

interface ReceiveQueueBoxPubSubMessageDependencies {
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy: ResourceInboxRetryPolicy;
    readonly jitterUnit: () => number;
    readonly onValidatedOutboxKeyReceived?: (entry: ResourceEntry) => void;
}

interface SendRemoteQueueBoxOutboxEntryDependencies {
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy: ResourceInboxRetryPolicy;
    readonly jitterUnit: () => number;
}

interface ResolveResourceEntryFromPubSubMessageDependencies {
    readonly loadByKey: (
        key: QueueBoxPubSubMessageKey
    ) => Promise<ResourceEntry | undefined>;
    readonly timing?: RallarTimingSink;
}

export function installQueueBoxPubSubBridge(
    options: InstallQueueBoxPubSubBridgeOptions
): Promise<void> {
    const {
        wsQBoxServerService,
        bridge,
        channel,
        publisherId,
        timing,
        retryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
        jitterUnit = Math.random
    } = options;

    registerQueueBoxOutboxPublisher({
        wsQBoxServerService,
        bridge,
        channel,
        publisherId,
        timing
    });
    const readiness = timeRallarAsync(
        timing,
        {
            component: 'queuebox-pubsub',
            operation: 'listener-subscribe',
            details: { channel }
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
                    onValidatedOutboxKeyReceived: options.onValidatedOutboxKeyReceived
                });
            });
        }
    );
    void readiness.catch((error) => {
        console.error('QueueBox pub/sub bridge listener failed:', error);
    });

    return readiness;
}

function registerQueueBoxOutboxPublisher(
    options: RegisterQueueBoxOutboxPublisherInput
): void {
    options.wsQBoxServerService.onOutboxClusterPublishDo(async (message, entry) => {
        const envelope = toPubSubMessage({
            channel: options.channel,
            publisherId: options.publisherId,
            entry
        });
        await options.bridge.publish(
            options.channel,
            envelope
        );
        recordPubSubTiming({
            timing: options.timing,
            operation: 'outbox-cluster-publish',
            message: envelope
        });
        const result = options.wsQBoxServerService.sendToTargetsWithResult(message);
        recordPubSubTiming({
            timing: options.timing,
            operation: 'outbox-direct-send',
            message: envelope,
            details: {
                localPublisherId: options.publisherId,
                deliveryStatus: result.status,
                recipientCount: result.recipientCount,
                sentCount: result.sentCount,
                failedCount: result.failedCount
            }
        });
        if (result.failedCount > 0) {
            throw new Error(`Failed ${result.failedCount} local WS outbox sends`);
        }
    });
}

async function receiveQueueBoxPubSubMessage(
    wireValue: JsonWireValue,
    options: ReceiveQueueBoxPubSubMessageDependencies
): Promise<void> {
    const message = decodeQueueBoxPubSubMessage(wireValue, options.channel);
    if (!message) {
        recordPubSubTiming({
            timing: options.timing,
            operation: 'drop-malformed',
            message: undefined
        });
        return;
    }
    if (message.publisherId === options.publisherId) {
        return;
    }
    recordRallarTiming({
        sink: options.timing,
        event: {
            component: 'queuebox-pubsub',
            operation: 'cluster-receive',
            details: {
                channel: options.channel,
                delivery: message.delivery,
                entryKind: 'ws-outbox'
            }
        },
        status: 'ok',
        durationMs: 0
    });
    const entry = await resolveResourceEntryFromPubSubMessage(message, {
        loadByKey: async (key) => await options.wsQBoxServerService.outbox.getItem(key),
        timing: options.timing
    });
    if (!entry) {
        return;
    }
    notifyValidatedOutboxKey(entry, options.onValidatedOutboxKeyReceived);
    await sendRemoteQueueBoxOutboxEntry(message, entry, {
        wsQBoxServerService: options.wsQBoxServerService,
        publisherId: options.publisherId,
        timing: options.timing,
        retryPolicy: options.retryPolicy,
        jitterUnit: options.jitterUnit
    });
}

function notifyValidatedOutboxKey(
    entry: ResourceEntry,
    callback: ((entry: ResourceEntry) => void) | undefined
): void {
    try {
        callback?.(entry);
    }
    catch (error) {
        console.error('QueueBox validated outbox-key callback failed:', error);
    }
}

async function sendRemoteQueueBoxOutboxEntry(
    message: QueueBoxPubSubMessage,
    entry: ResourceEntry,
    options: SendRemoteQueueBoxOutboxEntryDependencies
): Promise<void> {
    const result = options.wsQBoxServerService.sendToTargetsWithResult(
        decodePersistedALMessage(entry.resource)
    );
    recordPubSubTiming({
        timing: options.timing,
        operation: 'outbox-direct-send',
        message,
        details: {
            localPublisherId: options.publisherId,
            deliveryStatus: result.status,
            recipientCount: result.recipientCount,
            sentCount: result.sentCount,
            failedCount: result.failedCount
        }
    });
    if (result.failedCount === 0) {
        return;
    }

    const requeued = await requeueRemoteWsOutboxDeliveryFailure(
        options.wsQBoxServerService.outbox,
        entry,
        {
            retryPolicy: options.retryPolicy,
            jitterUnit: options.jitterUnit
        }
    );
    recordPubSubTiming({
        timing: options.timing,
        operation: 'outbox-remote-send-failed',
        message,
        details: {
            localPublisherId: options.publisherId,
            recipientCount: result.recipientCount,
            failedCount: result.failedCount,
            durableStatus: requeued?.status ?? 'stale',
            reservationAttempt: entry.dequeueAudit.attempts
        }
    });
}

export interface ToPubSubMessageInput {
    readonly channel: string;
    readonly publisherId: string;
    readonly entry: ResourceEntry;
}

export function toPubSubMessage(input: ToPubSubMessageInput): QueueBoxPubSubMessage {
    const { channel, publisherId, entry } = input;
    if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
        throw new TypeError('QueueBox cluster notifications require admitted WS outbox work');
    }

    return {
        key: entry.key,
        channel,
        publisherId,
        typeId: entry.typeId,
        delivery: 'key'
    };
}

async function resolveResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubMessage,
    options: ResolveResourceEntryFromPubSubMessageDependencies
): Promise<ResourceEntry | undefined> {
    const entry = await options.loadByKey(message.key);
    if (!entry) {
        recordPubSubTiming({
            timing: options.timing,
            operation: 'key-load-miss',
            message
        });
        return undefined;
    }
    if (!isKeysEqual(entry.key, message.key) || entry.typeId !== message.typeId) {
        recordPubSubTiming({
            timing: options.timing,
            operation: 'key-load-mismatch',
            message
        });
        return undefined;
    }
    recordPubSubTiming({
        timing: options.timing,
        operation: 'outbox-key-loaded',
        message
    });

    return entry;
}

interface RecordPubSubTimingInput {
    readonly timing: RallarTimingSink | undefined;
    readonly operation: string;
    readonly message: Partial<QueueBoxPubSubMessage> | undefined;
    readonly details?: RallarTimingDetails;
}

function recordPubSubTiming(input: RecordPubSubTimingInput): void {
    const { timing, operation, message, details = {} } = input;
    recordRallarTiming({
        sink: timing,
        event: {
            component: 'queuebox-pubsub',
            operation,
            serviceId: message?.publisherId,
            details: { ...toPubSubTimingDetails(message), ...details }
        },
        status: 'ok',
        durationMs: 0
    });
}

function toPubSubTimingDetails(
    message: Partial<QueueBoxPubSubMessage> | undefined
): RallarTimingDetails {
    return {
        channel: message?.channel,
        delivery: message?.delivery,
        topicId: message?.key?.topicId,
        resourceId: message?.key?.resourceId,
        contextId: message?.key?.contextId,
        typeId: message?.typeId
    };
}

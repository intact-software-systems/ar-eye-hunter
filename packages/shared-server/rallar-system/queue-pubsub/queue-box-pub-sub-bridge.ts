import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import {
    decodeALOutboundCanonicalMessage,
    decodeALOutboundIdentityEntry,
    toALOutboundIdentityKey
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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
    readonly clock?: ALOutboundMessageRuntime.Clock;
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly bridge: QueueBoxPubSubBridge;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy?: ResourceInboxRetryPolicy;
    readonly jitterUnit?: () => number;
    readonly onValidatedOutboxKeyReceived?: (entry: ResourceEntry) => void;
    /**
     * Announces a requeued row to the engine that owns the outbox. A requeue writes outside every ALM
     * runtime, so absence leaves the row waiting out the owner's idle ceiling.
     */
    readonly wakeQueueEngine?: () => void;
}

interface RegisterQueueBoxOutboxPublisherInput {
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly bridge: QueueBoxPubSubBridge;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
}

interface ReceiveQueueBoxPubSubMessageDependencies {
    readonly clock: ALOutboundMessageRuntime.Clock;
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy: ResourceInboxRetryPolicy;
    readonly jitterUnit: () => number;
    readonly onValidatedOutboxKeyReceived?: (entry: ResourceEntry) => void;
    readonly wakeQueueEngine?: () => void;
}

interface SendRemoteQueueBoxOutboxEntryDependencies {
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy: ResourceInboxRetryPolicy;
    readonly jitterUnit: () => number;
    readonly wakeQueueEngine?: () => void;
}

interface ResolveResourceEntryFromPubSubMessageDependencies {
    readonly clock: ALOutboundMessageRuntime.Clock;
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
        jitterUnit = Math.random,
        clock = { nowMs: Date.now }
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
                    clock,
                    wsQBoxServerService,
                    channel,
                    publisherId,
                    timing,
                    retryPolicy,
                    jitterUnit,
                    onValidatedOutboxKeyReceived: options.onValidatedOutboxKeyReceived,
                    wakeQueueEngine: options.wakeQueueEngine
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
        clock: options.clock,
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
        jitterUnit: options.jitterUnit,
        wakeQueueEngine: options.wakeQueueEngine
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
    if (requeued !== undefined) {
        options.wakeQueueEngine?.();
    }
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

    const message = decodePersistedALMessage(entry.resource);
    const expiresAtMs = resolveALMessageExpireAtMs(message);
    if (
        expiresAtMs === undefined || !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs > entry.audit.expiryTs.epochMilliseconds
    ) {
        throw new TypeError('Cluster notification requires a canonical logical deadline');
    }
    const notice: QueueBoxPubSubMessage = {
        key: entry.key,
        channel,
        publisherId,
        typeId: entry.typeId,
        delivery: 'key',
        expiresAtMs
    };
    if (!decodeQueueBoxPubSubMessage(notice, channel)) {
        throw new TypeError('QueueBox notification exceeds physical key or wire bounds');
    }
    return notice;
}

async function resolveResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubMessage,
    options: ResolveResourceEntryFromPubSubMessageDependencies
): Promise<ResourceEntry | undefined> {
    if (message.expiresAtMs <= options.clock.nowMs()) {
        return undefined;
    }
    const entry = await options.loadByKey(message.key);
    if (message.expiresAtMs <= options.clock.nowMs()) {
        return undefined;
    }
    if (!entry) {
        recordPubSubTiming({
            timing: options.timing,
            operation: 'key-load-miss',
            message
        });
        throw new ALAdmissionCorruptionError(
            JSON.stringify(message.key),
            new TypeError('Live cluster canonical message is missing')
        );
    }
    const canonical = decodePersistedALMessage(entry.resource);
    if (
        !isKeysEqual(entry.key, message.key) || entry.typeId !== message.typeId ||
        resolveALMessageExpireAtMs(canonical) !== message.expiresAtMs ||
        entry.audit.expiryTs.epochMilliseconds < message.expiresAtMs
    ) {
        recordPubSubTiming({
            timing: options.timing,
            operation: 'key-load-mismatch',
            message
        });
        throw new ALAdmissionCorruptionError(
            JSON.stringify(message.key),
            new TypeError('Cluster notification differs from canonical message')
        );
    }
    if (message.expiresAtMs <= options.clock.nowMs()) {
        return undefined;
    }
    if (!await readLiveCanonicalIdentityForNotice(entry, message, options)) {
        return undefined;
    }
    recordPubSubTiming({
        timing: options.timing,
        operation: 'outbox-key-loaded',
        message
    });

    return entry;
}

async function readLiveCanonicalIdentityForNotice(
    entry: ResourceEntry,
    message: QueueBoxPubSubMessage,
    options: ResolveResourceEntryFromPubSubMessageDependencies
): Promise<boolean> {
    const identityEntry = await options.loadByKey(toALOutboundIdentityKey(entry.key));
    if (message.expiresAtMs <= options.clock.nowMs()) {
        return false;
    }
    if (!identityEntry) {
        throw new ALAdmissionCorruptionError(
            JSON.stringify(entry.key),
            new TypeError('Live cluster canonical identity is missing')
        );
    }
    const reference = decodeALOutboundIdentityEntry(identityEntry).reference;
    decodeALOutboundCanonicalMessage(reference, entry, identityEntry);
    if (
        !isKeysEqual(reference.key, message.key) || reference.typeId !== message.typeId ||
        reference.expiresAtMs !== message.expiresAtMs
    ) {
        throw new ALAdmissionCorruptionError(
            JSON.stringify(entry.key),
            new TypeError('Cluster notification differs from retained identity')
        );
    }
    return true;
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

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    decodeALOutboundCanonicalMessage,
    decodeALOutboundIdentityEntry,
    toALOutboundIdentityKey
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundReceiptFacts } from '@shared/alm/outbound/lane/al-outbound-receipt-observation.ts';
import type { ALWorkObservationDeferral } from '@shared/alm/work/al-work-handler.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    type ResourceInboxRetryPolicy
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { ExclusionKeyedAdmission } from '@shared/resilience/exclusion-keyed-admission.ts';
import { readWsQueueBoxServerEligibleAudience } from '@shared/services/ws-queue-box-server/scope/read-ws-queue-box-server-eligible-audience.ts';
import { validateWsQueueBoxServerRecipientAuthority } from '@shared/services/ws-queue-box-server/scope/requires-ws-queue-box-server-recipient-scope.ts';
import {
    isWsQueueBoxServerCapturedSessionRow,
    toWsQueueBoxServerCapturedSendInput,
    toWsQueueBoxServerHeldSessionPolicy
} from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-captured-send-input.ts';
import type { WsQueueBoxServerClusterPublication } from '@shared/services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts';
import type {
    WsCapturedRecipientEligibilityFilter,
    WsServerLiveSendInputDto,
    WsServerLiveSendResult
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import {
    recordWsQueueBoxServerReceiptObservation,
    type WsQueueBoxServerReceiptObserver
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { isWsQueueBoxServerReceiptRow } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-row.ts';
import type { ExpectedConnectionHolds } from '@shared/websocket/expected-connection-holds.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
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
    readonly socket: Pick<JsonWebSocketServer, 'expectedConnections'>;
    onOutboxClusterPublishDo(publisher: WsQueueBoxServerClusterPublication.Publisher): QueueBoxPubSubWsService;
    /** The policy the row's own commit handed over is checked instead of read back. */
    readCapturedPolicy(
        message: ALMessage,
        entry: ResourceEntry,
        committedPolicy: ALOutboundCapturedPolicy | undefined
    ): Promise<ALOutboundCapturedPolicy>;
    sendToTargetsWithResult(input: WsServerLiveSendInputDto): WsServerLiveSendResult;
    requiresFrozenAudience(message: ALMessage): boolean;
}

export interface InstallQueueBoxPubSubBridgeOptions {
    readonly receiptObserver?: WsQueueBoxServerReceiptObserver;
    readonly clock?: ALOutboundMessageRuntime.Clock;
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly bridge: QueueBoxPubSubBridge;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy?: ResourceInboxRetryPolicy;
    readonly jitterUnit?: () => number;
    readonly onValidatedOutboxKeyReceived?: (entry: ResourceEntry) => void;
    /** Re-checks a row's captured sessions before each local send: every scoped row's, and a frozen-audience row's (D498). */
    readonly filterEligibleCapturedSessionIds?: WsCapturedRecipientEligibilityFilter;
    /**
     * Announces a requeued row to the engine that owns the outbox. A requeue writes outside every ALM
     * runtime, so absence leaves the row waiting out the owner's idle ceiling.
     */
    readonly wakeQueueEngine?: () => void;
}

interface RegisterQueueBoxOutboxPublisherInput {
    readonly receiptObserver: WsQueueBoxServerReceiptObserver | undefined;
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly bridge: QueueBoxPubSubBridge;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly filterEligibleCapturedSessionIds?: InstallQueueBoxPubSubBridgeOptions['filterEligibleCapturedSessionIds'];
    /** One session's held sends, run one after the other so they reach it in the order they were held. */
    readonly heldSends: ExclusionKeyedAdmission;
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
    readonly filterEligibleCapturedSessionIds?: InstallQueueBoxPubSubBridgeOptions['filterEligibleCapturedSessionIds'];
    /** One session's held sends, run one after the other so they reach it in the order they were held. */
    readonly heldSends: ExclusionKeyedAdmission;
}

interface SendRemoteQueueBoxOutboxEntryDependencies {
    readonly wsQBoxServerService: QueueBoxPubSubWsService;
    readonly publisherId: string;
    readonly timing?: RallarTimingSink;
    readonly retryPolicy: ResourceInboxRetryPolicy;
    readonly jitterUnit: () => number;
    readonly wakeQueueEngine?: () => void;
    readonly filterEligibleCapturedSessionIds?: InstallQueueBoxPubSubBridgeOptions['filterEligibleCapturedSessionIds'];
    /** One session's held sends, run one after the other so they reach it in the order they were held. */
    readonly heldSends: ExclusionKeyedAdmission;
}

interface RequeueFailedRemoteOutboxEntryInput {
    readonly message: QueueBoxPubSubMessage;
    readonly entry: ResourceEntry;
    readonly options: SendRemoteQueueBoxOutboxEntryDependencies;
    readonly result: Pick<WsServerLiveSendResult, 'recipientCount' | 'failedCount'>;
}

interface SendToCapturedLocalTargetsInput {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly policy: ALOutboundCapturedPolicy | undefined;
}

interface QueueBoxOutboxPublication {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly committedPolicy: ALOutboundCapturedPolicy | undefined;
    readonly deferObservation: ALWorkObservationDeferral | undefined;
}

interface ObserveCapturedLocalSendInput extends SendToCapturedLocalTargetsInput {
    readonly result: WsServerLiveSendResult;
    readonly envelope: QueueBoxPubSubMessage;
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
    const heldSends = new ExclusionKeyedAdmission({ maxConcurrent: Number.MAX_SAFE_INTEGER, keyedChainsFirst: false });

    registerQueueBoxOutboxPublisher({
        wsQBoxServerService,
        bridge,
        channel,
        publisherId,
        timing,
        filterEligibleCapturedSessionIds: options.filterEligibleCapturedSessionIds,
        heldSends,
        receiptObserver: options.receiptObserver
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
                    wakeQueueEngine: options.wakeQueueEngine,
                    filterEligibleCapturedSessionIds: options.filterEligibleCapturedSessionIds,
                    heldSends
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
    options.wsQBoxServerService.onOutboxClusterPublishDo((message, entry, handoff) =>
        writeQueueBoxOutboxPublication({
            message,
            entry,
            committedPolicy: handoff.committedPolicy,
            deferObservation: handoff.deferObservation
        }, options)
    );
}

async function writeQueueBoxOutboxPublication(
    publication: QueueBoxOutboxPublication,
    options: RegisterQueueBoxOutboxPublisherInput
): Promise<void> {
    const { message, entry, deferObservation } = publication;
    const facts = options.receiptObserver === undefined ? undefined : toALOutboundReceiptFacts(message);
    const serverPeerId = message.id.senderId;
    let publishCall: 'not-called' | 'invoked' | 'returned' = 'not-called';
    let directCall: 'not-called' | 'invoked' | 'returned' = 'not-called';
    let result: WsServerLiveSendResult | undefined;
    let outcome: 'returned' | 'threw' = 'threw';
    try {
        const envelope = toPubSubMessage({ channel: options.channel, publisherId: options.publisherId, entry });
        publishCall = 'invoked';
        await publishOutboxClusterNotice(envelope, options);
        publishCall = 'returned';
        const policy = options.timing === undefined
            ? await readCapturedPublicationPolicy(options.wsQBoxServerService, publication)
            : await readLocalPublicationPolicy(publication, envelope, options);
        directCall = 'invoked';
        result = await sendToCapturedLocalTargets({ message, entry, policy }, options);
        directCall = 'returned';
        observeCapturedLocalSend({ message, entry, policy, result, envelope }, options);
        if (result.failedCount > 0) {
            throw new Error(`Failed ${result.failedCount} local WS outbox sends`);
        }
        outcome = 'returned';
    }
    finally {
        if (facts !== undefined) {
            recordWsQueueBoxServerReceiptObservation(options.receiptObserver, {
                ...facts,
                kind: 'receipt-publication',
                serverPeerId,
                publisherId: options.publisherId,
                publishCall,
                directCall,
                outcome,
                directStatus: result?.status,
                recipientCount: result?.recipientCount,
                sentCount: result?.sentCount,
                failedCount: result?.failedCount
            }, deferObservation);
        }
    }
}

/** One endpoint separates the captured-policy read from synchronous send and deferred-audience bookkeeping. */
async function readLocalPublicationPolicy(
    publication: QueueBoxOutboxPublication,
    envelope: QueueBoxPubSubMessage,
    options: RegisterQueueBoxOutboxPublisherInput
): Promise<ALOutboundCapturedPolicy | undefined> {
    let status: 'ok' | 'error' = 'error';
    try {
        const policy = await readCapturedPublicationPolicy(options.wsQBoxServerService, publication);
        status = 'ok';
        return policy;
    }
    finally {
        if (options.timing !== undefined) {
            recordPubSubTiming({
                timing: options.timing,
                operation: 'outbox-captured-policy-read',
                message: envelope,
                details: { capturedPolicy: publication.committedPolicy === undefined ? 'stored' : 'committed' },
                status
            });
        }
    }
}

/** Holds awaited local recipients and records the completed direct-send boundary. */
function observeCapturedLocalSend(
    input: ObserveCapturedLocalSendInput,
    options: RegisterQueueBoxOutboxPublisherInput
): void {
    const { message, entry, policy, result, envelope } = input;
    const awaited = deferAwaitedCapturedRecipients({ message, entry, policy }, result, options);
    recordPubSubTiming({
        timing: options.timing,
        operation: 'outbox-direct-send',
        message: envelope,
        details: {
            localPublisherId: options.publisherId,
            deliveryStatus: result.status,
            recipientCount: result.recipientCount,
            sentCount: result.sentCount,
            failedCount: result.failedCount,
            deferredCount: awaited.heldCount,
            deferEvictedCount: awaited.evictedCount
        }
    });
}

/** The actual cluster publish call and its existing return endpoint share one side-effect boundary. */
async function publishOutboxClusterNotice(
    envelope: QueueBoxPubSubMessage,
    options: RegisterQueueBoxOutboxPublisherInput
): Promise<void> {
    if (options.timing !== undefined) {
        recordPubSubTiming({ timing: options.timing, operation: 'outbox-cluster-publish-start', message: envelope });
    }
    try {
        await options.bridge.publish(options.channel, envelope);
    }
    catch (error) {
        if (options.timing !== undefined) {
            recordPubSubTiming({
                timing: options.timing,
                operation: 'outbox-cluster-publish-error',
                message: envelope,
                status: 'error'
            });
        }
        throw error;
    }
    recordPubSubTiming({ timing: options.timing, operation: 'outbox-cluster-publish', message: envelope });
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
        wakeQueueEngine: options.wakeQueueEngine,
        filterEligibleCapturedSessionIds: options.filterEligibleCapturedSessionIds,
        heldSends: options.heldSends
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
    const remoteMessage = decodePersistedALMessageRow(entry);
    let result: WsServerLiveSendResult;
    let awaited: ExpectedConnectionHolds.AudienceHold;
    try {
        const policy = await readCapturedPublicationPolicy(
            options.wsQBoxServerService,
            { message: remoteMessage, entry, committedPolicy: undefined }
        );
        result = await sendToCapturedLocalTargets({ message: remoteMessage, entry, policy }, options);
        awaited = deferAwaitedCapturedRecipients({ message: remoteMessage, entry, policy }, result, options);
    }
    catch (error) {
        if (error instanceof ALAdmissionCorruptionError) {
            throw error;
        }
        await requeueFailedRemoteOutboxEntry({
            message,
            entry,
            options,
            result: { recipientCount: 0, failedCount: 1 }
        });
        return;
    }
    recordPubSubTiming({
        timing: options.timing,
        operation: 'outbox-direct-send',
        message,
        details: {
            localPublisherId: options.publisherId,
            deliveryStatus: result.status,
            recipientCount: result.recipientCount,
            sentCount: result.sentCount,
            failedCount: result.failedCount,
            deferredCount: awaited.heldCount,
            deferEvictedCount: awaited.evictedCount
        }
    });
    if (result.failedCount === 0) {
        return;
    }

    await requeueFailedRemoteOutboxEntry({ message, entry, options, result });
}

async function requeueFailedRemoteOutboxEntry(
    input: RequeueFailedRemoteOutboxEntryInput
): Promise<void> {
    const { message, entry, options, result } = input;
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

/** A receipt row answers its origin and carries no captured policy of its own. */
async function readCapturedPublicationPolicy(
    service: QueueBoxPubSubWsService,
    row: Pick<QueueBoxOutboxPublication, 'message' | 'entry' | 'committedPolicy'>
): Promise<ALOutboundCapturedPolicy | undefined> {
    return isWsQueueBoxServerReceiptRow(row.message)
        ? undefined
        : await service.readCapturedPolicy(row.message, row.entry, row.committedPolicy);
}

/** A row with failed sends is retried, and its redelivery reaches the awaited session; only a settled row is held. */
function deferAwaitedCapturedRecipients(
    input: SendToCapturedLocalTargetsInput,
    result: Pick<WsServerLiveSendResult, 'failedCount'>,
    options: Pick<
        SendRemoteQueueBoxOutboxEntryDependencies,
        'wsQBoxServerService' | 'filterEligibleCapturedSessionIds' | 'heldSends'
    >
): ExpectedConnectionHolds.AudienceHold {
    const { policy } = input;
    if (result.failedCount > 0 || policy === undefined) {
        return { heldCount: 0, evictedCount: 0 };
    }
    return options.wsQBoxServerService.socket.expectedConnections.holdForAudience(policy.admittedAudience ?? [], {
        expiresAtEpochMs: input.entry.audit.expiryTs.epochMilliseconds,
        send: (sessionId) => {
            // One session's held rows re-check one after the other, so they reach it in the order they were held.
            void options.heldSends.admit(
                sessionId,
                () =>
                    sendToCapturedLocalTargets(
                        { ...input, policy: toWsQueueBoxServerHeldSessionPolicy(policy, sessionId) },
                        options
                    )
            ).catch((error) => console.error('Held WebSocket send failed:', error));
        }
    });
}

async function sendToCapturedLocalTargets(
    input: SendToCapturedLocalTargetsInput,
    options: Pick<SendRemoteQueueBoxOutboxEntryDependencies, 'wsQBoxServerService' | 'filterEligibleCapturedSessionIds'>
): Promise<WsServerLiveSendResult> {
    const { message, entry, policy } = input;
    if (
        policy?.principalTargetId !== undefined &&
        validateWsQueueBoxServerRecipientAuthority(message, policy, entry.key).length > 0
    ) {
        throw new ALAdmissionCorruptionError(
            JSON.stringify(entry.key),
            new TypeError('Captured WS recipient authority differs from the publication target')
        );
    }
    const eligible = await readCapturedEligibleSessionIds(input, options);
    return options.wsQBoxServerService.sendToTargetsWithResult(
        toWsQueueBoxServerCapturedSendInput({ message, key: entry.key, policy, eligibleSessionIds: eligible })
    );
}

/**
 * The captured sessions a local send may address: re-checked for a scoped row and a frozen-audience row, nobody for a
 * frozen-audience row with no re-check wired; undefined leaves the send to resolve the row's targets.
 */
async function readCapturedEligibleSessionIds(
    { message, entry, policy }: SendToCapturedLocalTargetsInput,
    options: Pick<SendRemoteQueueBoxOutboxEntryDependencies, 'wsQBoxServerService' | 'filterEligibleCapturedSessionIds'>
): Promise<readonly string[] | undefined> {
    const captured = policy?.admittedAudience;
    const frozen = options.wsQBoxServerService.requiresFrozenAudience(message);
    if (captured === undefined || policy?.sessionInvalidation !== undefined) {
        return undefined;
    }
    if (!frozen && !isWsQueueBoxServerCapturedSessionRow(message, entry.key)) {
        return undefined;
    }
    const filter = options.filterEligibleCapturedSessionIds;
    if (filter === undefined) {
        return frozen ? [] : undefined;
    }
    return await readWsQueueBoxServerEligibleAudience({
        message,
        admittedAudience: captured,
        admittedConnectionGenerationIds: policy?.admittedConnectionGenerationIds,
        provenScope: policy?.recipientScope,
        filterEligibleCapturedSessionIds: filter
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

    const message = decodePersistedALMessageRow(entry);
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
    const canonical = decodePersistedALMessageRow(entry);
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
    readonly operation:
        | 'outbox-cluster-publish-start'
        | 'outbox-cluster-publish-error'
        | 'outbox-cluster-publish'
        | 'outbox-captured-policy-read'
        | 'outbox-direct-send'
        | 'drop-malformed'
        | 'outbox-remote-send-failed'
        | 'key-load-miss'
        | 'key-load-mismatch'
        | 'outbox-key-loaded';
    readonly message: Partial<QueueBoxPubSubMessage> | undefined;
    readonly details?: RallarTimingDetails;
    readonly status?: 'ok' | 'error';
}

function recordPubSubTiming(input: RecordPubSubTimingInput): void {
    const { timing, operation, message, details = {}, status = 'ok' } = input;
    recordRallarTiming({
        sink: timing,
        event: {
            component: 'queuebox-pubsub',
            operation,
            serviceId: message?.publisherId,
            details: { ...toPubSubTimingDetails(message), ...details }
        },
        status,
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

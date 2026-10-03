import { Either } from '@shared/resilience/Either.ts';

import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import {
    normalizeALQosPolicy,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldAwaitALRoute,
    type ALQosEffectivePolicy,
    type ALQosInputProvider,
    type ALQosNormalizationResult
} from '../../al-contracts/al-policy.ts';
import { resolveALOutboundScopeAuthority } from '../../alm/outbound/admission/al-outbound-scope-authority.ts';
import type { ALSessionInvalidationAuthority } from '../../alm/outbound/admission/al-session-invalidation-authority.ts';
import { computeALOutboundAckRefusal } from '../../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundRepairRequest,
    ALOutboundRepairTrackingPlan,
    ALOutboundSupersedenceTrackingPlan
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import {
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../../alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '../../alm/outbound/to-al-outbound-message.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { Key } from '../../queuebox/ResourceEntry.ts';
import {
    isWsQueueBoxServerDirectScopedBroadcastRow,
    validateWsQueueBoxServerRecipientAuthority
} from './scope/requires-ws-queue-box-server-recipient-scope.ts';
import { toWsQueueBoxServerRecipientPreparedMessages } from './scope/to-ws-queue-box-server-recipient-prepared-messages.ts';
import type { WsServerResolvedRecipient } from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import { isWsQueueBoxServerReceiptRow } from './ws-queue-box-server-receipt-row.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export type WsQueueBoxServerPreparedMessage =
    | Readonly<{
        kind: 'invalidated-session';
        peerId: string;
        connectionId: string;
        generationId: string;
        sessionInvalidation: ALSessionInvalidationAuthority;
        message: ALOutboundTransportMessage;
    }>
    | Readonly<{
        kind: 'scoped-recipient';
        peerId: string;
        connectionId: string;
        generationId: string;
        recipientScope: StateScope;
        principalTargetId?: string;
        message: ALOutboundTransportMessage;
    }>
    | Readonly<{
        /** A recipient of a row whose targets name a group: its send checks the connection against that group. */
        kind: 'room-recipient';
        peerId: string;
        connectionId: string;
        generationId: string;
        message: ALOutboundTransportMessage;
    }>
    | Readonly<{
        kind: 'recipient';
        peerId: string;
        connectionId: string;
        message: ALOutboundTransportMessage;
    }>
    | Readonly<{
        kind: 'cluster-local-complete';
        message: ALOutboundTransportMessage;
    }>
    | Readonly<{
        /** A receipt published by whichever worker claims it, resolving its origin at execution. */
        kind: 'cluster-receipt';
        message: ALOutboundTransportMessage;
    }>;

export type WsQueueBoxServerOutboundPhase = 'immediate' | 'dequeue';

interface ToExpectedPeerIdsInput {
    readonly message: ALMessage;
    readonly recipients: readonly WsServerResolvedRecipient[];
    readonly audience: readonly string[] | undefined;
    readonly effective: ALQosEffectivePolicy;
}

export namespace WsQueueBoxServerOutboundPlanning {
    export interface Dependencies {
        readonly serverPeerId: string;
        readonly qosProvider: ALQosInputProvider;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
    }

    export interface Request {
        readonly message: ALMessage;
        readonly phase: WsQueueBoxServerOutboundPhase;
        readonly clusterPublisherRegistered: boolean;
        /** The audience the router admitted the message to, carried beside it; absent for every other message. */
        readonly admittedAudience: readonly string[] | undefined;
        readonly recipientScope?: StateScope;
        readonly principalTargetId?: string;
        readonly sessionInvalidation?: ALSessionInvalidationAuthority;
        readonly referenceKey?: Key;
    }

    export interface RecipientResolution {
        readonly resolveRecipients: boolean;
        readonly representNoCurrentRecipient: boolean;
        readonly allowClusterRecipients: boolean;
        /** The audience the message was admitted or frozen to: never a session that joined after it (D24, D43). */
        readonly audience: readonly string[] | undefined;
        readonly capturedSessions: boolean;
    }
}

export class WsQueueBoxServerOutboundPlanning {
    readonly #serverPeerId: string;
    readonly #qosProvider: ALQosInputProvider;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #deliveryReporting: WsQueueBoxServerDeliveryReporting;

    constructor(dependencies: WsQueueBoxServerOutboundPlanning.Dependencies) {
        this.#serverPeerId = dependencies.serverPeerId;
        this.#qosProvider = dependencies.qosProvider;
        this.#targetResolution = dependencies.targetResolution;
        this.#deliveryReporting = dependencies.deliveryReporting;
    }

    planOutboundMessage(
        request: WsQueueBoxServerOutboundPlanning.Request
    ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
        const normalized = this.resolvePolicy(request.message);
        const message = toALOutboundMessage(request.message, normalized.effective);
        const issues = validateWsQueueBoxServerRecipientAuthority(message, request, request.referenceKey);
        if (issues.length > 0) {
            return {
                msg: message,
                lane: 'volatile',
                preparedMessages: [],
                dropReasonCode: 'unauthorized',
                dropReason: 'WS message has no verified scoped audience'
            };
        }
        const refusal = computeALOutboundAckRefusal<WsQueueBoxServerPreparedMessage>({
            msg: message,
            carrier: 'ws',
            policy: normalized
        });
        if (refusal.left) {
            return refusal.left;
        }
        return this.planRecipientDispatch(request, message, normalized);
    }

    private planRecipientDispatch(
        request: WsQueueBoxServerOutboundPlanning.Request,
        message: ALMessage,
        normalized: ALQosNormalizationResult
    ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
        const { phase, clusterPublisherRegistered, admittedAudience } = request;
        const recipientScope = request.recipientScope === undefined ? undefined : { ...request.recipientScope };
        const directBroadcast = isWsQueueBoxServerDirectScopedBroadcastRow(message, request.referenceKey);
        const audience = admittedAudience ?? resolveALFrozenMulticastAudience(message.targets)?.recipientPeerIds;
        const awaitsRoute = shouldAwaitALRoute(normalized.effective);
        const resolveRecipients = phase === 'dequeue' || !awaitsRoute;
        const resolved = this.readRecipients(message, {
            resolveRecipients,
            representNoCurrentRecipient: phase === 'dequeue',
            allowClusterRecipients: phase === 'dequeue' && clusterPublisherRegistered,
            audience,
            capturedSessions: directBroadcast || request.principalTargetId !== undefined ||
                request.sessionInvalidation !== undefined
        });
        if (resolved.right === undefined) {
            return toNoRouteDispatchPlan(
                message,
                `Invalid WS server outbound message ${message.id.msgId}: ${resolved.left}`
            );
        }
        const recipients = resolved.right;
        return {
            msg: message,
            dropReasonCode: undefined,
            lane: awaitsRoute ? 'durable' : 'volatile',
            preparedMessages: phase === 'dequeue' && clusterPublisherRegistered
                ? toClusterPreparedMessages(message)
                : this.toPreparedRecipients(message, recipients, { ...request, recipientScope }),
            ackTracking: toAckTrackingPlan(
                normalized.effective,
                resolveRecipients
                    ? toExpectedPeerIds({ message, recipients, audience, effective: normalized.effective })
                    : []
            ),
            repairTracking: toRepairTrackingPlan(normalized.effective),
            supersedenceTracking: toSupersedenceTrackingPlan(normalized.effective, message),
            ...(admittedAudience === undefined ? {} : { admittedAudience }),
            ...(request.sessionInvalidation === undefined
                ? {}
                : { sessionInvalidation: request.sessionInvalidation }),
            ...(recipientScope === undefined ? {} : { recipientScope }),
            ...(request.principalTargetId === undefined ? {} : { principalTargetId: request.principalTargetId })
        };
    }

    private toPreparedRecipients(
        message: ALMessage,
        recipients: readonly WsServerResolvedRecipient[],
        request: Pick<
            WsQueueBoxServerOutboundPlanning.Request,
            'recipientScope' | 'principalTargetId' | 'sessionInvalidation' | 'referenceKey'
        >
    ): readonly WsQueueBoxServerPreparedMessage[] {
        return toWsQueueBoxServerRecipientPreparedMessages({
            message,
            recipients,
            authority: resolveALOutboundScopeAuthority(message, request).right!,
            referenceKey: request.referenceKey,
            readConnectionGeneration: (connectionId) => this.#targetResolution.getConnectionGeneration(connectionId)
        });
    }

    /**
     * A repair or retry resends to the failed recipients connected here that the message was admitted to, and its
     * receipt keeps every peer it expects and every one that confirmed: a session that left or sits on another instance
     * still reads unconfirmed, and one that joined after admission is never added (D24, D43). WS never re-routes, so no
     * receipt mode replaces its expected set.
     */
    planRepairMessage(
        message: ALMessage,
        request: ALOutboundRepairRequest
    ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> | undefined {
        if (validateWsQueueBoxServerRecipientAuthority(message, request, request.referenceKey).length > 0) {
            return undefined;
        }
        const directBroadcast = isWsQueueBoxServerDirectScopedBroadcastRow(message, request.referenceKey);
        const requested = request.requestedByPeerId ? [request.requestedByPeerId] : request.failedPeerIds;
        const eligibleRequested = request.admittedAudience === undefined
            ? requested
            : requested.filter((peerId) => request.admittedAudience?.includes(peerId));
        const recipients = directBroadcast || request.principalTargetId !== undefined ||
                request.sessionInvalidation !== undefined
            ? this.#targetResolution.resolveCapturedSessionRecipients(
                message,
                eligibleRequested
            )
            : this.#targetResolution.resolveRepairRecipients(message, eligibleRequested);
        if (recipients.length === 0) {
            return undefined;
        }

        const effective = this.resolvePolicy(message).effective;
        return {
            msg: message,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: this.toPreparedRecipients(message, recipients, request),
            admittedAudience: request.admittedAudience,
            recipientScope: request.recipientScope,
            principalTargetId: request.principalTargetId,
            sessionInvalidation: request.sessionInvalidation,
            ackTracking: toAckTrackingPlan(
                effective,
                recipients.map((recipient) => recipient.peerId),
                'merge'
            ),
            repairTracking: request.repair
        };
    }

    isBroadcastWithoutRecipients(message: ALMessage, error: string): boolean {
        const noRecipientsReason = toNoResolvedRecipientsReason('broadcast', message.id.msgId);
        return message.targets?.mode === 'broadcast' && (
            error === noRecipientsReason ||
            error === `Invalid WS server outbound message ${message.id.msgId}: ${noRecipientsReason}`
        );
    }

    private readRecipients(
        message: ALMessage,
        resolution: WsQueueBoxServerOutboundPlanning.RecipientResolution
    ): Either<string, readonly WsServerResolvedRecipient[]> {
        const targets = message.targets;
        if (!targets) {
            return Either.ofLeft(
                `Cannot route WS server outbound message ${message.id.msgId} without explicit targets`
            );
        }
        if (!resolution.resolveRecipients || resolution.audience?.length === 0) {
            return Either.ofRight([]);
        }

        const resolved = resolution.capturedSessions
            ? this.#targetResolution.resolveCapturedSessionRecipients(message, resolution.audience ?? [])
            : this.#targetResolution.resolveOutboundRecipients(message);
        const audience = resolution.audience;
        const recipients = audience === undefined
            ? resolved
            : resolved.filter((recipient) => audience.includes(recipient.peerId));
        if (recipients.length > 0) {
            return Either.ofRight(recipients);
        }
        if (resolution.representNoCurrentRecipient) {
            this.#deliveryReporting.recordOutcome({
                status: 'no-current-recipient',
                messageId: message.id.msgId
            });
            this.#deliveryReporting.recordDiagnostics({
                kind: 'no-local-recipient',
                topicId: message.route.topicId
            });
        }
        return resolution.allowClusterRecipients
            ? Either.ofRight([])
            : Either.ofLeft(toNoResolvedRecipientsReason(targets.mode, message.id.msgId));
    }

    resolvePolicy(message: ALMessage): ALQosNormalizationResult {
        return normalizeALQosPolicy(
            message,
            resolveALQosNormalizationInput(
                message,
                { direction: 'outbound', selfPeerId: this.#serverPeerId },
                this.#qosProvider
            )
        );
    }
}

function toNoResolvedRecipientsReason(
    mode: NonNullable<ALMessage['targets']>['mode'],
    messageId: string
): string {
    return `Cannot resolve WS server recipients for ${mode} message ${messageId}`;
}

function toNoRouteDispatchPlan(
    message: ALMessage,
    dropReason: string
): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
    return { msg: message, dropReason, dropReasonCode: 'no-route', lane: 'volatile', preparedMessages: [] };
}

/**
 * A `receiver` receipt counts logical recipients, so a message admitted to an audience expects all of it,
 * connected here or not; every other receipt counts the hops this instance sends to.
 */
function toExpectedPeerIds(input: ToExpectedPeerIdsInput): readonly string[] {
    const { message, recipients, audience } = input;
    return input.effective.ack.algo === 'receiver' && audience !== undefined
        ? audience.filter((peerId) => peerId !== message.id.senderId)
        : recipients.map((recipient) => recipient.peerId);
}

/**
 * With a cluster publisher the dequeue publishes the row and completes, except for a receipt: it goes to
 * its origin's session here, or repeats its cluster publication until the origin has a session here or
 * the row expires.
 */
function toClusterPreparedMessages(
    message: ALMessage
): readonly WsQueueBoxServerPreparedMessage[] {
    if (!isWsQueueBoxServerReceiptRow(message)) {
        return [{ kind: 'cluster-local-complete', message: toALOutboundTransportMessage(message) }];
    }
    return [{ kind: 'cluster-receipt', message: toALOutboundTransportMessage(message) }];
}

function toAckTrackingPlan(
    effective: ALQosEffectivePolicy,
    expectedPeerIds: readonly string[],
    expectedPeerIdsUpdate?: 'merge' | 'replace'
): ALOutboundAckTrackingPlan | undefined {
    if (effective.ack.algo === 'none') {
        return undefined;
    }
    const nextHopPeerIds = [...new Set(expectedPeerIds)];
    return {
        enabled: true,
        timeoutMs: effective.ack.opts.timeoutMs,
        maxAttempts: effective.retry.algo === 'none' ? 0 : effective.retry.opts.maxAttempts,
        expectedPeerIds: nextHopPeerIds,
        expectedPeerIdsUpdate,
        nextHopPeerIds,
        mode: effective.ack.algo
    };
}

function toRepairTrackingPlan(
    effective: ALQosEffectivePolicy
): ALOutboundRepairTrackingPlan | undefined {
    return effective.repair.algo === 'none'
        ? undefined
        : {
            enabled: true,
            algo: effective.repair.algo,
            maxAttempts: effective.repair.opts.maxRepairs
        };
}

function toSupersedenceTrackingPlan(
    effective: ALQosEffectivePolicy,
    message: ALMessage
): ALOutboundSupersedenceTrackingPlan | undefined {
    return effective.supersedence.algo === 'none'
        ? undefined
        : {
            enabled: true,
            algo: effective.supersedence.algo,
            key: resolveSupersedenceKey(message, effective),
            replacesMsgId: effective.supersedence.opts.replacesMsgId
        };
}

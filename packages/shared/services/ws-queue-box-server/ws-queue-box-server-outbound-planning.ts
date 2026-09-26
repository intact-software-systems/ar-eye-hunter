import { Either } from '@shared/resilience/Either.ts';
import { computeALOutboundAckRefusal } from '../../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
import {
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../../alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '../../alm/outbound/to-al-outbound-message.ts';

import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import {
    normalizeALQosPolicy,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import { toALReceiverAckNormalizationInput } from '../../al-contracts/validate-al-ack-support.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundRepairRequest,
    ALOutboundRepairTrackingPlan,
    ALOutboundSupersedenceTrackingPlan
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { WsServerResolvedRecipient } from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import { isWsQueueBoxServerReceiptRow } from './ws-queue-box-server-receipt-row.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export type WsQueueBoxServerPreparedMessage =
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
        /** A receipt whose origin has no session here: sent here once it has one, published to the cluster until then. */
        kind: 'cluster-receipt';
        message: ALOutboundTransportMessage;
    }>;

export type WsQueueBoxServerOutboundPhase = 'immediate' | 'dequeue';

export namespace WsQueueBoxServerOutboundPlanning {
    export interface Dependencies {
        readonly serverPeerId: string;
        readonly qosProvider?: ALQosInputProvider;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
    }

    export interface RecipientResolution {
        readonly resolveRecipients: boolean;
        readonly representNoCurrentRecipient: boolean;
        readonly allowClusterRecipients: boolean;
    }
}

export class WsQueueBoxServerOutboundPlanning {
    readonly #serverPeerId: string;
    readonly #qosProvider?: ALQosInputProvider;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #deliveryReporting: WsQueueBoxServerDeliveryReporting;

    constructor(dependencies: WsQueueBoxServerOutboundPlanning.Dependencies) {
        this.#serverPeerId = dependencies.serverPeerId;
        this.#qosProvider = dependencies.qosProvider;
        this.#targetResolution = dependencies.targetResolution;
        this.#deliveryReporting = dependencies.deliveryReporting;
    }

    planOutboundMessage(
        original: ALMessage,
        phase: WsQueueBoxServerOutboundPhase,
        clusterPublisherRegistered: boolean
    ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
        const normalized = this.normalizePolicy(original);
        const message = toALOutboundMessage(original, normalized.effective);
        const persist = shouldPersistOutbox(normalized.effective);
        const refusal = computeALOutboundAckRefusal<WsQueueBoxServerPreparedMessage>({
            msg: message,
            carrier: 'ws',
            policy: normalized
        });
        if (refusal.left) {
            return refusal.left;
        }

        const resolveRecipients = phase === 'dequeue' || !persist;
        return this.validateMessage(message, {
            resolveRecipients,
            representNoCurrentRecipient: phase === 'dequeue',
            allowClusterRecipients: phase === 'dequeue' && clusterPublisherRegistered
        }).fold(
            (error) =>
                toNoRouteDispatchPlan(message, `Invalid WS server outbound message ${message.id.msgId}: ${error}`),
            (recipients) => ({
                msg: message,
                dropReasonCode: undefined,
                persist,
                preparedMessages: phase === 'dequeue' && clusterPublisherRegistered
                    ? toClusterPreparedMessages(message, recipients)
                    : toRecipientPreparedMessages(message, recipients),
                ackTracking: toAckTrackingPlan(
                    normalized.effective,
                    resolveRecipients ? toExpectedPeerIds(message, recipients) : []
                ),
                repairTracking: toRepairTrackingPlan(normalized.effective),
                supersedenceTracking: toSupersedenceTrackingPlan(normalized.effective, message)
            })
        );
    }

    planRepairMessage(
        message: ALMessage,
        request: ALOutboundRepairRequest
    ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> | undefined {
        const recipients = request.requestedByPeerId
            ? this.#targetResolution.resolveRepairRecipients(message, [request.requestedByPeerId])
            : this.#targetResolution.resolveRepairRecipients(message, request.failedPeerIds);
        if (recipients.length === 0) {
            return undefined;
        }

        return {
            msg: message,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: toRecipientPreparedMessages(message, recipients),
            ackTracking: toAckTrackingPlan(
                this.normalizePolicy(message).effective,
                recipients.map((recipient) => recipient.peerId),
                'replace'
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

    private validateMessage(
        message: ALMessage,
        resolution: WsQueueBoxServerOutboundPlanning.RecipientResolution
    ): Either<string, readonly WsServerResolvedRecipient[]> {
        const targets = message.targets;
        if (!targets) {
            return Either.ofLeft(
                `Cannot route WS server outbound message ${message.id.msgId} without explicit targets`
            );
        }
        if (!resolution.resolveRecipients) {
            return Either.ofRight([]);
        }

        const recipients = toFrozenAudienceRecipients(
            message,
            this.#targetResolution.resolveOutboundRecipients(message)
        );
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

    private normalizePolicy(message: ALMessage): ReturnType<typeof normalizeALQosPolicy> {
        return normalizeALQosPolicy(
            message,
            toALReceiverAckNormalizationInput(resolveALQosNormalizationInput(
                message,
                { direction: 'outbound', selfPeerId: this.#serverPeerId },
                this.#qosProvider
            ))
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
    return { msg: message, dropReason, dropReasonCode: 'no-route', persist: false, preparedMessages: [] };
}

/**
 * A multicast frozen at admission goes to the audience it was frozen to, never to a session that
 * joined the room after it (D24, D43); any other message goes to every recipient resolved now.
 */
function toFrozenAudienceRecipients(
    message: ALMessage,
    resolved: readonly WsServerResolvedRecipient[]
): readonly WsServerResolvedRecipient[] {
    const frozen = resolveALFrozenMulticastAudience(message.targets);
    return frozen === undefined
        ? resolved
        : resolved.filter((recipient) => frozen.recipientPeerIds.includes(recipient.peerId));
}

/** A frozen multicast expects its whole frozen audience, connected here or not; any other message its recipients here. */
function toExpectedPeerIds(message: ALMessage, recipients: readonly WsServerResolvedRecipient[]): readonly string[] {
    const frozen = resolveALFrozenMulticastAudience(message.targets);
    return frozen === undefined
        ? recipients.map((recipient) => recipient.peerId)
        : frozen.recipientPeerIds.filter((peerId) => peerId !== message.id.senderId);
}

function toRecipientPreparedMessages(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[]
): readonly WsQueueBoxServerPreparedMessage[] {
    return recipients.map((recipient) => ({
        kind: 'recipient',
        peerId: recipient.peerId,
        connectionId: recipient.connectionId,
        message: toALOutboundTransportMessage(message)
    }));
}

/**
 * With a cluster publisher the dequeue publishes the row and completes, except for a receipt: it goes to
 * its origin's session here, or repeats its cluster publication until the origin has a session here or
 * the row expires.
 */
function toClusterPreparedMessages(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[]
): readonly WsQueueBoxServerPreparedMessage[] {
    if (!isWsQueueBoxServerReceiptRow(message)) {
        return [{ kind: 'cluster-local-complete', message: toALOutboundTransportMessage(message) }];
    }
    return recipients.length > 0
        ? toRecipientPreparedMessages(message, recipients)
        : [{ kind: 'cluster-receipt', message: toALOutboundTransportMessage(message) }];
}

function toAckTrackingPlan(
    effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
    expectedPeerIds: readonly string[],
    expectedPeerIdsUpdate?: 'merge' | 'replace'
): ALOutboundAckTrackingPlan | undefined {
    if (effective.ack.algo === 'none') {
        return undefined;
    }
    return {
        enabled: true,
        timeoutMs: effective.ack.opts.timeoutMs,
        maxAttempts: effective.retry.algo === 'none' ? 0 : effective.retry.opts.maxAttempts,
        expectedPeerIds: [...new Set(expectedPeerIds)],
        expectedPeerIdsUpdate,
        mode: effective.ack.algo
    };
}

function toRepairTrackingPlan(
    effective: ReturnType<typeof normalizeALQosPolicy>['effective']
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
    effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
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

import { Either } from '@shared/resilience/Either.ts';

import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    normalizeALQosPolicy,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundRepairRequest,
    ALOutboundRepairTrackingPlan,
    ALOutboundSupersedenceTrackingPlan
} from '../../alm/ALOutboundMessageRuntime.ts';
import type { WsServerResolvedRecipient } from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export type WsQueueBoxServerPreparedMessage =
    | Readonly<{
        kind: 'recipient';
        peerId: string;
        connectionId: string;
        message: ALMessage;
    }>
    | Readonly<{
        kind: 'cluster-local-complete';
        message: ALMessage;
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
        message: ALMessage,
        phase: WsQueueBoxServerOutboundPhase,
        clusterPublisherRegistered: boolean
    ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
        const normalized = this.normalizePolicy(message);
        const persist = shouldPersistOutbox(normalized.effective);

        return this.validateMessage(message, {
            resolveRecipients: phase === 'dequeue' || !persist,
            representNoCurrentRecipient: phase === 'dequeue'
        }).fold(
            (error) =>
                toNoRouteDispatchPlan(
                    `Invalid WS server outbound message ${message.id.msgId}: ${error}`
                ),
            (recipients) => ({
                persist,
                preparedMessages: phase === 'dequeue' && clusterPublisherRegistered
                    ? [{ kind: 'cluster-local-complete', message }]
                    : recipients.map((recipient) => ({
                        kind: 'recipient',
                        peerId: recipient.peerId,
                        connectionId: recipient.connectionId,
                        message
                    })),
                ackTracking: toAckTrackingPlan(normalized.effective, recipients),
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
            persist: false,
            preparedMessages: recipients.map((recipient) => ({
                kind: 'recipient',
                peerId: recipient.peerId,
                connectionId: recipient.connectionId,
                message
            })),
            ackTracking: toAckTrackingPlan(
                this.normalizePolicy(message).effective,
                recipients,
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

        const recipients = this.#targetResolution.resolveOutboundRecipients(message);
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
        return Either.ofLeft(toNoResolvedRecipientsReason(targets.mode, message.id.msgId));
    }

    private normalizePolicy(message: ALMessage): ReturnType<typeof normalizeALQosPolicy> {
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
    dropReason: string
): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
    return { dropReason, persist: false, preparedMessages: [] };
}

function toAckTrackingPlan(
    effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
    recipients: readonly WsServerResolvedRecipient[],
    mode?: 'merge' | 'replace'
): ALOutboundAckTrackingPlan | undefined {
    if (effective.ack.algo === 'none' || recipients.length === 0) {
        return undefined;
    }
    return {
        enabled: true,
        timeoutMs: effective.ack.opts.timeoutMs,
        maxAttempts: effective.retry.algo === 'none' ? 0 : effective.retry.opts.maxAttempts,
        expectedPeerIds: [...new Set(recipients.map((recipient) => recipient.peerId))],
        mode
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

import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { normalizeALQosPolicy, resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { validateALOutboundRecipientScope } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import { validateALSessionInvalidationMessage } from '../../alm/outbound/admission/al-session-invalidation-authority.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { EncodedJsonWebSocketMessage, JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import { requiresWsQueueBoxServerRecipientScope } from './requires-ws-queue-box-server-recipient-scope.ts';
import type {
    WsServerInboundConnectionScopeReader,
    WsServerLiveSendFailure,
    WsServerLiveSendInputDto,
    WsServerLiveSendResult,
    WsServerLiveSendStatus,
    WsServerResolvedRecipient
} from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerRecipientSelection } from './ws-queue-box-server-recipient-selection.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerLiveDelivery {
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
        readonly readAuthenticatedConnectionScope:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    }

    export interface EncodedAttempt {
        readonly encoded: EncodedJsonWebSocketMessage | null;
        readonly failureReason: string | null;
    }

    export interface SendAttempt {
        readonly sentCount: number;
        readonly failures: readonly WsServerLiveSendFailure[];
        readonly expired: boolean;
    }

    export interface SendInput {
        readonly encoded: EncodedJsonWebSocketMessage;
        readonly recipients: readonly WsServerResolvedRecipient[];
        readonly expiresAtMs: number | undefined;
        readonly scope: StateScope | undefined;
        readonly principalId: string | undefined;
        readonly requireAuthenticatedRecipient: boolean;
        readonly invalidatedSessionId: string | undefined;
        readonly generations: ReadonlyMap<string, string | undefined>;
    }

    export interface SendToResolvedPeerInputDto {
        readonly peerId: string;
        readonly message: ALMessage;
        readonly encoded?: EncodedJsonWebSocketMessage;
        readonly inboundScope?: StateScope | null;
    }
}

export class WsQueueBoxServerLiveDelivery {
    readonly #socket: JsonWebSocketServer;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #deliveryReporting: WsQueueBoxServerDeliveryReporting;
    readonly #recipientSelection: WsQueueBoxServerRecipientSelection;

    constructor(dependencies: WsQueueBoxServerLiveDelivery.Dependencies) {
        this.#socket = dependencies.socket;
        this.#targetResolution = dependencies.targetResolution;
        this.#deliveryReporting = dependencies.deliveryReporting;
        this.#recipientSelection = new WsQueueBoxServerRecipientSelection(dependencies);
    }

    sendToTargets(message: ALMessage): number {
        return this.sendToTargetsWithResult({ message }).sentCount;
    }

    /** Unicast scope is recipient policy, not proof that a local recipient exists. */
    sendToTargetsWithResult(input: WsServerLiveSendInputDto): WsServerLiveSendResult {
        const { message, inboundScope } = input;
        if (validateLiveSendAuthority(input).length > 0) {
            return noRecipientResult(message);
        }
        const expiresAtMs = input.expiresAtMs ??
            resolveALMessageExpireAtMs(message, normalizeALQosPolicy(message).effective);
        if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
            return toLiveSendResult(message, [], { sentCount: 0, failures: [], expired: true });
        }
        const recipients = input.sessionInvalidation === undefined
            ? this.#recipientSelection.resolveLiveRecipients(input)
            : this.#targetResolution.resolveCapturedSessionRecipients(message, [input.sessionInvalidation.sessionId]);
        if (recipients.length === 0) {
            this.#deliveryReporting.recordDiagnostics({
                kind: 'no-local-recipient',
                topicId: message.route.topicId
            });
            return noRecipientResult(message);
        }

        const generations = new Map(
            recipients.map((
                recipient
            ) => [recipient.connectionId, this.#socket.connections.get(recipient.connectionId)?.generationId])
        );
        const encodedAttempt = this.toEncodedAttempt(message);
        if (!encodedAttempt.encoded) {
            return encodingFailureResult(message, recipients, encodedAttempt.failureReason!);
        }

        const sendAttempt = this.sendEncodedToRecipients({
            encoded: encodedAttempt.encoded,
            invalidatedSessionId: input.sessionInvalidation?.sessionId,
            recipients,
            expiresAtMs,
            scope: input.recipientScope ??
                (message.targets?.mode === 'unicast' ? inboundScope ?? undefined : undefined),
            principalId: input.recipientPrincipalId,
            requireAuthenticatedRecipient: input.requireAuthenticatedRecipient === true ||
                input.recipientScope !== undefined ||
                (message.targets?.mode === 'unicast' && inboundScope !== undefined),
            generations
        });
        this.#deliveryReporting.recordDiagnostics({
            kind: 'live-send',
            topicId: message.route.topicId,
            recipientCount: recipients.length,
            sentCount: sendAttempt.sentCount,
            payloadBytes: encodedAttempt.encoded.text.length
        });
        return toLiveSendResult(message, recipients, sendAttempt);
    }

    sendToResolvedPeer(input: WsQueueBoxServerLiveDelivery.SendToResolvedPeerInputDto): number {
        const { peerId, message, encoded, inboundScope } = input;
        if (
            requiresWsQueueBoxServerRecipientScope(message) && validateALOutboundRecipientScope(inboundScope).length > 0
        ) {
            return 0;
        }
        const expiresAtMs = resolveALMessageExpireAtMs(message, normalizeALQosPolicy(message).effective);
        if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
            return 0;
        }
        const resolved = this.#targetResolution.resolveRepairRecipients(message, [peerId]);
        const recipients = inboundScope === undefined || message.targets?.mode !== 'unicast'
            ? resolved
            : resolved.filter((recipient) =>
                inboundScope !== null &&
                this.#recipientSelection.isCurrentAuthorized(recipient, inboundScope)
            );
        const generations = new Map(
            recipients.map((
                recipient
            ) => [recipient.connectionId, this.#socket.connections.get(recipient.connectionId)?.generationId])
        );
        const encodedMessage = encoded ?? this.tryEncodeDirectMessage(message);
        if (!encodedMessage) {
            return 0;
        }
        return this.sendEncodedToRecipients({
            encoded: encodedMessage,
            invalidatedSessionId: undefined,
            recipients,
            expiresAtMs,
            scope: message.targets?.mode === 'unicast' ? inboundScope ?? undefined : undefined,
            principalId: undefined,
            requireAuthenticatedRecipient: inboundScope !== undefined && message.targets?.mode === 'unicast',
            generations
        }).sentCount;
    }

    tryEncodeDirectMessage(message: ALMessage): EncodedJsonWebSocketMessage | undefined {
        const attempt = this.toEncodedAttempt(message);
        return attempt.encoded ?? undefined;
    }

    private toEncodedAttempt(message: ALMessage): WsQueueBoxServerLiveDelivery.EncodedAttempt {
        try {
            return { encoded: this.#socket.encode(message), failureReason: null };
        }
        catch (error) {
            const runtimeError = error instanceof Error ? error : new Error(String(error));
            console.error(`Error encoding WS server message ${message.id.msgId}`, runtimeError);
            return { encoded: null, failureReason: runtimeError.message };
        }
    }

    private sendEncodedToRecipients(
        input: WsQueueBoxServerLiveDelivery.SendInput
    ): WsQueueBoxServerLiveDelivery.SendAttempt {
        const { encoded, recipients, expiresAtMs, scope, principalId, requireAuthenticatedRecipient, generations } =
            input;
        let sentCount = 0;
        const failures: WsServerLiveSendFailure[] = [];
        for (const recipient of recipients) {
            if (
                input.invalidatedSessionId !== undefined &&
                (recipient.connectionId !== input.invalidatedSessionId ||
                    !this.#socket.connections.get(recipient.connectionId)?.isOpen ||
                    this.#socket.connections.get(recipient.connectionId)?.generationId !==
                        generations.get(recipient.connectionId))
            ) {
                continue;
            }
            if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
                return { sentCount, failures, expired: true };
            }
            if (
                requireAuthenticatedRecipient && (
                    this.#socket.connections.get(recipient.connectionId)?.generationId !==
                        generations.get(recipient.connectionId) ||
                    !this.#recipientSelection.isCurrentAuthorized(recipient, scope, principalId)
                )
            ) {
                continue;
            }
            try {
                this.#socket.sendEncoded(recipient.connectionId, encoded);
                sentCount += 1;
            }
            catch (error) {
                const runtimeError = error instanceof Error ? error : new Error(String(error));
                failures.push({
                    peerId: recipient.peerId,
                    connectionId: recipient.connectionId,
                    reason: runtimeError.message
                });
                console.error(
                    `Error sending WS server message to ${recipient.connectionId}`,
                    runtimeError
                );
            }
        }
        return { sentCount, failures, expired: false };
    }
}

function validateLiveSendAuthority(input: WsServerLiveSendInputDto): readonly string[] {
    const issues: string[] = [];
    if (input.sessionInvalidation !== undefined) {
        issues.push(...validateALSessionInvalidationMessage(input.message, input.sessionInvalidation));
        if (input.recipientScope !== undefined || input.inboundScope !== undefined) {
            issues.push('Session-global authority cannot carry a scoped authority');
        }
    }
    else if (requiresWsQueueBoxServerRecipientScope(input.message)) {
        issues.push(...validateALOutboundRecipientScope(input.inboundScope));
    }
    if (input.recipientPrincipalId !== undefined && input.recipientScope === undefined) {
        issues.push('Principal audience requires its scope');
    }
    return issues;
}

function noRecipientResult(message: ALMessage): WsServerLiveSendResult {
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

function encodingFailureResult(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[],
    reason: string
): WsServerLiveSendResult {
    return {
        status: 'failed',
        message,
        recipients,
        recipientCount: recipients.length,
        sentCount: 0,
        failedCount: recipients.length,
        failures: recipients.map((recipient) => ({
            peerId: recipient.peerId,
            connectionId: recipient.connectionId,
            reason
        }))
    };
}

function toLiveSendResult(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[],
    attempt: WsQueueBoxServerLiveDelivery.SendAttempt
): WsServerLiveSendResult {
    if (!attempt.expired && attempt.sentCount === 0 && attempt.failures.length === 0) {
        return noRecipientResult(message);
    }
    return {
        status: attempt.expired
            ? 'expired'
            : toLiveSendStatus(attempt.sentCount, attempt.failures.length),
        message,
        recipients,
        recipientCount: recipients.length,
        sentCount: attempt.sentCount,
        failedCount: attempt.failures.length,
        failures: attempt.failures
    };
}

function toLiveSendStatus(
    sentCount: number,
    failedCount: number
): WsServerLiveSendStatus {
    if (failedCount === 0) {
        return 'sent-live';
    }
    return sentCount > 0 ? 'partial-failure' : 'failed';
}

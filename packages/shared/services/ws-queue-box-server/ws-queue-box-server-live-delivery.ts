import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { normalizeALQosPolicy, resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { isALWorldBroadcast } from '../../al-contracts/is-al-world-broadcast.ts';
import { validateALAccountViewMessage } from '../../alm/outbound/admission/al-account-view-authority.ts';
import { validateALOutboundRecipientScope } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import { validateALSessionInvalidationMessage } from '../../alm/outbound/admission/al-session-invalidation-authority.ts';
import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { AppTopics } from '../../api/api-config.ts';
import type { StateScope } from '../../api/state-types.ts';
import { decodeViewInvalidationMessage } from '../../api/views/view-invalidation.ts';
import { Either } from '../../resilience/Either.ts';
import type { EncodedJsonWebSocketMessage, JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import { requiresWsQueueBoxServerRecipientScope } from './scope/requires-ws-queue-box-server-recipient-scope.ts';
import { resolveWsQueueBoxServerProvenScope } from './scope/resolve-ws-queue-box-server-recipient-scope.ts';
import {
    toWsQueueBoxServerRecipientCopies,
    type WsQueueBoxServerRecipientCopies
} from './scope/to-ws-queue-box-server-recipient-copies.ts';
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
        readonly clock: ALOutboundMessageRuntime.Clock;
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
        /** Each recipient's encoded copy, by connection. */
        readonly encodedByConnectionId: ReadonlyMap<string, EncodedJsonWebSocketMessage>;
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
    readonly #clock: ALOutboundMessageRuntime.Clock;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #deliveryReporting: WsQueueBoxServerDeliveryReporting;
    readonly #recipientSelection: WsQueueBoxServerRecipientSelection;

    constructor(dependencies: WsQueueBoxServerLiveDelivery.Dependencies) {
        this.#socket = dependencies.socket;
        this.#clock = dependencies.clock;
        this.#targetResolution = dependencies.targetResolution;
        this.#deliveryReporting = dependencies.deliveryReporting;
        this.#recipientSelection = new WsQueueBoxServerRecipientSelection(dependencies);
    }

    sendToTargets(message: ALMessage): number {
        return this.sendToTargetsWithResult({ message, sentPositions: null }).sentCount;
    }

    /** Unicast scope is recipient policy, not proof that a local recipient exists. */
    sendToTargetsWithResult(input: WsServerLiveSendInputDto): WsServerLiveSendResult {
        const { message } = input;
        if (validateLiveSendAuthority(input).length > 0) {
            return noRecipientResult(message);
        }
        const expiresAtMs = input.expiresAtMs ??
            resolveALMessageExpireAtMs(message, normalizeALQosPolicy(message).effective);
        if (expiresAtMs !== undefined && expiresAtMs <= this.#clock.nowMs()) {
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

        return this.writeLiveRecipients(input, recipients, expiresAtMs);
    }

    private writeLiveRecipients(
        input: WsServerLiveSendInputDto,
        recipients: readonly WsServerResolvedRecipient[],
        expiresAtMs: number | undefined
    ): WsServerLiveSendResult {
        const { message } = input;
        const provenScope = resolveWsQueueBoxServerProvenScope(message, input.inboundScope);
        const { copies, belowPositionPeerIds } = toWsQueueBoxServerRecipientCopies(
            message,
            recipients,
            input.sentPositions
        );
        const sent = copies.map((copy) => copy.recipient);
        // Read before encoding: a connection replaced while the frame encodes must not receive it.
        const generations = this.readGenerations(sent);
        const encoded = this.toEncodedCopies(copies);
        if (encoded.left !== undefined) {
            return encodingFailureResult(message, recipients, encoded.left);
        }
        const encodedByConnectionId = encoded.right!;
        const sendAttempt = this.sendEncodedToRecipients({
            encodedByConnectionId,
            invalidatedSessionId: input.sessionInvalidation?.sessionId,
            recipients: sent,
            expiresAtMs,
            scope: input.recipientScope ?? provenScope ?? undefined,
            principalId: input.accountView?.principalId ?? input.recipientPrincipalId,
            requireAuthenticatedRecipient: input.accountView !== undefined ||
                input.requireAuthenticatedRecipient === true ||
                input.recipientScope !== undefined || provenScope !== undefined,
            generations
        });
        this.#deliveryReporting.recordDiagnostics({
            kind: 'live-send',
            topicId: message.route.topicId,
            recipientCount: recipients.length,
            sentCount: sendAttempt.sentCount,
            payloadBytes: [...encodedByConnectionId.values()][0]?.text.length ?? 0
        });
        return { ...toLiveSendResult(message, sent, sendAttempt), belowPositionPeerIds };
    }

    /** Each copy encoded once per distinct entry, by connection; Left: why the first copy that cannot encode fails. */
    private toEncodedCopies(
        copies: WsQueueBoxServerRecipientCopies['copies']
    ): Either<string, ReadonlyMap<string, EncodedJsonWebSocketMessage>> {
        const byEntry = new Map<string, EncodedJsonWebSocketMessage>();
        const byConnectionId = new Map<string, EncodedJsonWebSocketMessage>();
        for (const { recipient, message } of copies) {
            const entryKey = JSON.stringify(message.ordering?.priorSeqByRecipient ?? null);
            const attempt = byEntry.has(entryKey) ? undefined : this.toEncodedAttempt(message);
            if (attempt !== undefined && !attempt.encoded) {
                return Either.ofLeft(attempt.failureReason!);
            }
            if (attempt?.encoded) {
                byEntry.set(entryKey, attempt.encoded);
            }
            byConnectionId.set(recipient.connectionId, byEntry.get(entryKey)!);
        }
        return Either.ofRight(byConnectionId);
    }

    private readGenerations(recipients: readonly WsServerResolvedRecipient[]): ReadonlyMap<string, string | undefined> {
        return new Map(recipients.map((recipient) => [
            recipient.connectionId,
            this.#socket.connections.get(recipient.connectionId)?.generationId
        ]));
    }

    sendToResolvedPeer(input: WsQueueBoxServerLiveDelivery.SendToResolvedPeerInputDto): number {
        const { peerId, message, encoded, inboundScope } = input;
        if (
            message.route.topicId === AppTopics.viewInvalidated || message.payload.typeId === AppTopics.viewInvalidated
        ) {
            return 0;
        }
        if (
            requiresWsQueueBoxServerRecipientScope(message) && validateALOutboundRecipientScope(inboundScope).length > 0
        ) {
            return 0;
        }
        const expiresAtMs = resolveALMessageExpireAtMs(message, normalizeALQosPolicy(message).effective);
        if (expiresAtMs !== undefined && expiresAtMs <= this.#clock.nowMs()) {
            return 0;
        }
        const provenScope = resolveWsQueueBoxServerProvenScope(message, inboundScope);
        const resolved = this.#targetResolution.resolveRepairRecipients(message, [peerId]);
        const recipients = provenScope === undefined
            ? resolved
            : resolved.filter((recipient) =>
                provenScope !== null && this.#recipientSelection.isCurrentAuthorized(recipient, provenScope)
            );
        const generations = this.readGenerations(recipients);
        const encodedMessage = encoded ?? this.tryEncodeDirectMessage(message);
        if (!encodedMessage) {
            return 0;
        }
        return this.sendEncodedToRecipients({
            encodedByConnectionId: new Map(recipients.map((recipient) => [recipient.connectionId, encodedMessage])),
            invalidatedSessionId: undefined,
            recipients,
            expiresAtMs,
            scope: provenScope ?? undefined,
            principalId: undefined,
            requireAuthenticatedRecipient: provenScope !== undefined,
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
        const { recipients, expiresAtMs, scope, principalId, requireAuthenticatedRecipient, generations } = input;
        let sentCount = 0;
        const failures: WsServerLiveSendFailure[] = [];
        for (const recipient of recipients) {
            if (
                input.invalidatedSessionId !== undefined &&
                !this.isCurrentInvalidatedSession(recipient, input)
            ) {
                continue;
            }
            if (expiresAtMs !== undefined && expiresAtMs <= this.#clock.nowMs()) {
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
                this.#socket.sendEncoded(
                    recipient.connectionId,
                    input.encodedByConnectionId.get(recipient.connectionId)!
                );
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

    private isCurrentInvalidatedSession(
        recipient: WsServerResolvedRecipient,
        input: WsQueueBoxServerLiveDelivery.SendInput
    ): boolean {
        const connection = this.#socket.connections.get(recipient.connectionId);
        return recipient.connectionId === input.invalidatedSessionId &&
            connection?.isOpen === true &&
            connection.generationId === input.generations.get(recipient.connectionId);
    }
}

function validateLiveSendAuthority(input: WsServerLiveSendInputDto): readonly string[] {
    const issues: string[] = [];
    if (input.accountView !== undefined) {
        const mixed = input.recipientScope !== undefined || input.inboundScope !== undefined ||
            input.recipientPrincipalId !== undefined || input.sessionInvalidation !== undefined ||
            input.recipientSessionIds !== undefined || input.admittedPeerIds !== undefined;
        return mixed
            ? ['Account view cannot carry another audience authority']
            : validateALAccountViewMessage(input.message, input.accountView);
    }
    if (
        input.message.route.topicId === AppTopics.viewInvalidated ||
        input.message.payload.typeId === AppTopics.viewInvalidated
    ) {
        try {
            const notice = decodeViewInvalidationMessage(input.message);
            if (
                notice.scope === null || notice.principalId !== input.recipientPrincipalId ||
                notice.scope.applicationId !== input.recipientScope?.applicationId ||
                notice.scope.workspaceId !== input.recipientScope.workspaceId
            ) {
                return ['Account view requires its exact authority'];
            }
        }
        catch {
            return ['Account view requires a valid envelope and authority'];
        }
    }
    if (input.sessionInvalidation !== undefined) {
        issues.push(...validateALSessionInvalidationMessage(input.message, input.sessionInvalidation));
        if (input.recipientScope !== undefined || input.inboundScope !== undefined) {
            issues.push('Session-global authority cannot carry a scoped authority');
        }
    }
    else if (requiresWsQueueBoxServerRecipientScope(input.message)) {
        issues.push(...validateALOutboundRecipientScope(input.inboundScope));
    }
    else if (isALWorldBroadcast(input.message)) {
        issues.push(...validateALOutboundRecipientScope(input.recipientScope ?? input.inboundScope));
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
        failures: [],
        belowPositionPeerIds: []
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
        })),
        belowPositionPeerIds: []
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
        failures: attempt.failures,
        belowPositionPeerIds: []
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

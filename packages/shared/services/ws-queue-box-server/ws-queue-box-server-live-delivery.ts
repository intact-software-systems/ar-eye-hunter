import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { normalizeALQosPolicy, resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { validateALOutboundRecipientScope } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { StateScope } from '../../api/state-types.ts';
import { hasServerPushedViewTopic } from '../../api/views/view-invalidation.ts';
import { Either } from '../../resilience/Either.ts';
import type { EncodedJsonWebSocketMessage, JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import { requiresWsQueueBoxServerRecipientScope } from './scope/requires-ws-queue-box-server-recipient-scope.ts';
import { resolveWsQueueBoxServerProvenScope } from './scope/resolve-ws-queue-box-server-recipient-scope.ts';
import {
    toWsQueueBoxServerRecipientCopies,
    type WsQueueBoxServerRecipientCopies
} from './scope/to-ws-queue-box-server-recipient-copies.ts';
import { validateLiveSendAuthority } from './scope/validate-live-send-authority.ts';
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

    /** One connection a live send called the native socket for, and what that call did. */
    export interface ConnectionWrite {
        readonly connectionId: string;
        readonly nativeCall: JsonWebSocketServer.SendEvidence['nativeCall'];
        readonly written: boolean;
    }

    export interface EvidencedPeerSend {
        readonly sentCount: number;
        readonly writes: readonly ConnectionWrite[];
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
        /** The send appends each connection's write here, for a caller that reads them; undefined on one that reads none. */
        readonly writes: ConnectionWrite[] | undefined;
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

        const result = this.writeLiveRecipients(input, recipients, expiresAtMs);
        if (input.roomSessionGenerations !== undefined) {
            this.#recipientSelection.closeFailedRoomSnapshotConnections(result.failures, input.roomSessionGenerations);
        }
        return result;
    }

    private writeLiveRecipients(
        input: WsServerLiveSendInputDto,
        recipients: readonly WsServerResolvedRecipient[],
        expiresAtMs: number | undefined
    ): WsServerLiveSendResult {
        const { message, sentPositions } = input;
        const provenScope = resolveWsQueueBoxServerProvenScope(message, input.inboundScope);
        const { copies, belowPositionPeerIds } = toWsQueueBoxServerRecipientCopies(message, recipients, sentPositions);
        const sent = copies.map((copy) => copy.recipient);
        // Read before encoding: a connection replaced while the frame encodes must not receive it.
        const generations = this.readGenerations(sent);
        const encoded = this.toEncodedCopies(copies);
        if (encoded.left !== undefined) {
            return encodingFailureResult(message, recipients, encoded.left);
        }
        const encodedByConnectionId = encoded.right!;
        const eligible = this.resolveAcceptingRecipients(sent, encodedByConnectionId);
        const sendAttempt = this.sendEncodedToRecipients({
            encodedByConnectionId,
            invalidatedSessionId: input.sessionInvalidation?.sessionId,
            recipients: eligible,
            expiresAtMs,
            scope: input.recipientScope ?? provenScope ?? undefined,
            principalId: input.accountView?.principalId ?? input.recipientPrincipalId,
            requireAuthenticatedRecipient: input.accountView !== undefined ||
                input.requireAuthenticatedRecipient === true ||
                input.recipientScope !== undefined || provenScope !== undefined,
            generations,
            writes: undefined
        });
        this.#deliveryReporting.recordDiagnostics({
            kind: 'live-send',
            topicId: message.route.topicId,
            recipientCount: eligible.length,
            sentCount: sendAttempt.sentCount,
            payloadBytes: [...encodedByConnectionId.values()][0]?.text.length ?? 0
        });
        return { ...toLiveSendResult(message, eligible, sendAttempt), belowPositionPeerIds };
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

    private resolveAcceptingRecipients(
        recipients: readonly WsServerResolvedRecipient[],
        encodedByConnectionId: ReadonlyMap<string, EncodedJsonWebSocketMessage>
    ): readonly WsServerResolvedRecipient[] {
        return recipients.filter(({ connectionId }) => {
            const socket = this.#socket.connections.get(connectionId)?.socket;
            return socket?.acceptsOutbound?.(encodedByConnectionId.get(connectionId)!.text) !== false;
        });
    }

    private readGenerations(recipients: readonly WsServerResolvedRecipient[]): ReadonlyMap<string, string | undefined> {
        return new Map(recipients.map((recipient) => [
            recipient.connectionId,
            this.#socket.connections.get(recipient.connectionId)?.generationId
        ]));
    }

    sendToResolvedPeer(input: WsQueueBoxServerLiveDelivery.SendToResolvedPeerInputDto): number {
        return this.sendToPeer(input, undefined);
    }

    sendToResolvedPeerWithEvidence(
        input: WsQueueBoxServerLiveDelivery.SendToResolvedPeerInputDto
    ): WsQueueBoxServerLiveDelivery.EvidencedPeerSend {
        const writes: WsQueueBoxServerLiveDelivery.ConnectionWrite[] = [];
        const sentCount = this.sendToPeer(input, writes);
        return { sentCount, writes };
    }

    private sendToPeer(
        input: WsQueueBoxServerLiveDelivery.SendToResolvedPeerInputDto,
        writes: WsQueueBoxServerLiveDelivery.ConnectionWrite[] | undefined
    ): number {
        const { peerId, message, encoded, inboundScope } = input;
        const refusesScope = requiresWsQueueBoxServerRecipientScope(message) &&
            validateALOutboundRecipientScope(inboundScope).length > 0;
        if (hasServerPushedViewTopic(message) || refusesScope) {
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
        const encodedByConnectionId = new Map(recipients.map((recipient) => [recipient.connectionId, encodedMessage]));
        return this.sendEncodedToRecipients({
            encodedByConnectionId,
            invalidatedSessionId: undefined,
            recipients: this.resolveAcceptingRecipients(recipients, encodedByConnectionId),
            expiresAtMs,
            scope: provenScope ?? undefined,
            principalId: undefined,
            requireAuthenticatedRecipient: provenScope !== undefined,
            generations,
            writes
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
            const failure = this.writeRecipient(
                recipient,
                input.encodedByConnectionId.get(recipient.connectionId)!,
                input.writes
            );
            if (failure === undefined) {
                sentCount += 1;
            }
            else {
                failures.push(failure);
            }
        }
        return { sentCount, failures, expired: false };
    }

    /** Why the native call threw, if it did; a send that collects writes is handed what the call did. */
    private writeRecipient(
        recipient: WsServerResolvedRecipient,
        encoded: EncodedJsonWebSocketMessage,
        writes: WsQueueBoxServerLiveDelivery.ConnectionWrite[] | undefined
    ): WsServerLiveSendFailure | undefined {
        if (writes === undefined) {
            return this.writeEncoded(recipient, encoded, undefined);
        }
        const evidence: JsonWebSocketServer.SendEvidence = { nativeCall: 'not-called' };
        const failure = this.writeEncoded(recipient, encoded, evidence);
        writes.push({
            connectionId: recipient.connectionId,
            nativeCall: evidence.nativeCall,
            written: failure === undefined
        });
        return failure;
    }

    private writeEncoded(
        recipient: WsServerResolvedRecipient,
        encoded: EncodedJsonWebSocketMessage,
        evidence: JsonWebSocketServer.SendEvidence | undefined
    ): WsServerLiveSendFailure | undefined {
        const { connectionId } = recipient;
        try {
            this.#socket.sendEncoded(connectionId, encoded, evidence);
            return undefined;
        }
        catch (error) {
            const runtimeError = error instanceof Error ? error : new Error(String(error));
            console.error(`Error sending WS server message to ${connectionId}`, runtimeError);
            return { peerId: recipient.peerId, connectionId, reason: runtimeError.message };
        }
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

import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import { prepareALNackControlMessage, type ALNackPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundReceiver, validateALInboundMessage } from '../../alm/inbound/validate-al-inbound-message.ts';
import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { Either } from '../../resilience/Either.ts';
import type { ConnectionContext, JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import {
    toWsQueueBoxServerScopeAuthorization,
    type WsQueueBoxServerScopeAuthorization,
    type WsQueueBoxServerScopeRefusal
} from './scope/to-ws-queue-box-server-scope-authorization.ts';
import { toWsQueueBoxServerAddresseeAuthorization } from './to-ws-queue-box-server-addressee-authorization.ts';
import type { WsQueueBoxServerAckRelay } from './ws-queue-box-server-ack-relay.ts';
import type {
    WsServerInboundAuthorization,
    WsServerInboundAuthorizer,
    WsServerInboundConnectionScopeProof,
    WsServerInboundConnectionScopeReader
} from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerControlDelivery } from './ws-queue-box-server-control-delivery.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerInboundAuthority {
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly serverPeerId: string;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly newControlId: () => string;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly controlDelivery: WsQueueBoxServerControlDelivery;
        readonly ackRelay: WsQueueBoxServerAckRelay;
        readonly validateInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        readonly readAuthenticatedConnectionScope:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    }

    export interface AuthorizedMessage {
        readonly message: ALMessage;
        readonly fromPeerId: string;
        readonly authorization: Extract<WsServerInboundAuthorization, { authorized: true; }>;
        readonly proof: WsServerInboundConnectionScopeProof;
    }

    export interface SocketOrigin {
        readonly message: ALMessage;
        readonly connection: ConnectionContext;
        readonly fromPeerId: string;
    }

    export interface AuthorizedCandidate {
        readonly origin: SocketOrigin;
        readonly authorization: Extract<WsServerInboundAuthorization, { authorized: true; }>;
    }

    export interface FinishedDecision {
        readonly kind: 'finished';
        readonly result: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>;
    }

    export type SocketOriginDecision = { readonly kind: 'origin'; readonly value: SocketOrigin; } | FinishedDecision;

    export type SocketAdmissionDecision =
        | { readonly kind: 'candidate'; readonly value: AuthorizedCandidate; }
        | FinishedDecision;

    export type AdmissionDecision =
        | { readonly kind: 'authorized'; readonly value: AuthorizedMessage; }
        | {
            readonly kind: 'refused';
            readonly message: ALMessage;
            readonly refusal: WsQueueBoxServerScopeRefusal;
        }
        | FinishedDecision;
}

export class WsQueueBoxServerInboundAuthority {
    private static readonly READINESS_RETRY_AFTER_MS = 50;

    readonly #socket: JsonWebSocketServer;
    readonly #serverPeerId: string;
    readonly #clock: ALOutboundMessageRuntime.Clock;
    readonly #newControlId: () => string;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #controlDelivery: WsQueueBoxServerControlDelivery;
    readonly #ackRelay: WsQueueBoxServerAckRelay;
    readonly #validateInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
    readonly #readAuthenticatedConnectionScope:
        WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    #authorizer: WsServerInboundAuthorizer | undefined;
    #disposed = false;

    constructor(dependencies: WsQueueBoxServerInboundAuthority.Dependencies) {
        this.#socket = dependencies.socket;
        this.#serverPeerId = dependencies.serverPeerId;
        this.#clock = dependencies.clock;
        this.#newControlId = dependencies.newControlId;
        this.#targetResolution = dependencies.targetResolution;
        this.#controlDelivery = dependencies.controlDelivery;
        this.#ackRelay = dependencies.ackRelay;
        this.#validateInboundMessage = dependencies.validateInboundMessage;
        this.#readAuthenticatedConnectionScope = dependencies.readAuthenticatedConnectionScope;
    }

    dispose(): void {
        this.#disposed = true;
    }

    authorizeInboundMessagesWith(authorizer: WsServerInboundAuthorizer): void {
        if (this.#authorizer !== undefined) {
            throw new Error('WS server inbound authorizer is already installed');
        }
        this.#authorizer = authorizer;
    }

    async readSocketAdmission(
        decoded: Either<ALMessageRejection, ALMessage>,
        connectionId: string
    ): Promise<WsQueueBoxServerInboundAuthority.SocketAdmissionDecision> {
        if (this.#disposed) {
            return { kind: 'finished', result: Either.ofRight({ kind: 'disposed' }) };
        }
        if (decoded.left) {
            return { kind: 'finished', result: Either.ofLeft(decoded.left) };
        }
        const message = decoded.right!;
        const origin = await this.readScopedSocketOrigin(message, connectionId);
        if (origin.kind === 'finished') {
            return origin;
        }
        if (isRoomScopedALMessage(message) && !this.#authorizer) {
            return {
                kind: 'finished',
                result: Either.ofLeft({
                    code: 'unsupported',
                    message: 'Room messages require a server authority provider'
                })
            };
        }
        const authorization = toWsQueueBoxServerAddresseeAuthorization({
            message,
            serverPeerId: this.#serverPeerId,
            sendNack: this.#authorizer?.sendNacks ?? false,
            authorization: await this.#authorizer?.authorize(message) ?? { authorized: true }
        });
        const current = this.readCurrentConnectionRefusal(connectionId, origin.value.connection);
        if (current) {
            return current;
        }
        if (!authorization.authorized) {
            return { kind: 'finished', result: await this.rejectIncomingMessage(message, authorization) };
        }
        return { kind: 'candidate', value: { origin: origin.value, authorization } };
    }

    resolveAuthorizedSocketAdmission(
        candidate: WsQueueBoxServerInboundAuthority.AuthorizedCandidate,
        connectionId: string
    ): WsQueueBoxServerInboundAuthority.AdmissionDecision {
        const { message, connection, fromPeerId } = candidate.origin;
        const current = this.readCurrentConnectionRefusal(connectionId, connection);
        if (current) {
            return current;
        }
        const scope = this.readScopeAuthorization(message, connection);
        if (!scope.authorized) {
            return { kind: 'refused', message, refusal: scope };
        }
        return {
            kind: 'authorized',
            value: { message, fromPeerId, authorization: candidate.authorization, proof: scope.proof }
        };
    }

    /** The scope is checked before anything reads the addressed room, so a foreign scope learns nothing of it. */
    private async readScopedSocketOrigin(
        message: ALMessage,
        connectionId: string
    ): Promise<WsQueueBoxServerInboundAuthority.SocketOriginDecision> {
        const connection = this.#socket.connections.get(connectionId);
        const fromPeerId = this.#targetResolution.resolvePeerIdForConnection(connectionId, message);
        if (!connection?.isOpen || !fromPeerId || message.id.senderId !== fromPeerId) {
            return toFinishedRejection({
                code: 'unauthorized',
                message: 'AL origin must match an authenticated live WS connection'
            });
        }
        const scope = this.readScopeAuthorization(message, connection);
        if (!scope.authorized) {
            return { kind: 'finished', result: await this.rejectIncomingMessage(message, scope) };
        }
        const protocol = validateALInboundMessage(
            message,
            { kind: 'ws-client', peerId: fromPeerId, authenticatedScope: scope.proof.scope },
            toALInboundReceiver(this.#serverPeerId, (ack) => this.#ackRelay.readRelayedAckRejection(ack))
        );
        if (protocol.left) {
            return toFinishedRejection(protocol.left);
        }
        const validation = this.#validateInboundMessage(message);
        if (validation.left) {
            return toFinishedRejection(validation.left);
        }
        return { kind: 'origin', value: { message, connection, fromPeerId } };
    }

    private readScopeAuthorization(
        message: ALMessage,
        connection: ConnectionContext
    ): WsQueueBoxServerScopeAuthorization {
        return toWsQueueBoxServerScopeAuthorization({
            message,
            proof: this.#readAuthenticatedConnectionScope(connection),
            nowMs: this.#clock.nowMs(),
            sendNack: this.#authorizer?.sendNacks ?? false
        });
    }

    private readCurrentConnectionRefusal(
        connectionId: string,
        connection: ConnectionContext
    ): WsQueueBoxServerInboundAuthority.FinishedDecision | undefined {
        if (this.#disposed) {
            return { kind: 'finished', result: Either.ofRight({ kind: 'disposed' }) };
        }
        if (this.#socket.connections.get(connectionId) !== connection || !connection.isOpen) {
            return toFinishedRejection({
                code: 'unauthorized',
                message: 'WS connection changed during authorization'
            });
        }
        return undefined;
    }

    async readPendingAdmissionAuthority(
        message: ALMessage,
        source: ALInboundMessageRuntime.Source
    ): Promise<ALInboundMessageRuntime.PendingAuthority> {
        const authority = await this.readCurrentDispatchAuthority(message);
        if (typeof authority === 'string') {
            return authority === 'retry'
                ? { kind: 'retry', retryAfterMs: WsQueueBoxServerInboundAuthority.READINESS_RETRY_AFTER_MS }
                : { kind: 'rejected' };
        }
        const audience = authority.roomAudience?.recipientPeerIds;
        if (source.kind !== 'ws-client' || audience === undefined) {
            return { kind: 'authorized', source };
        }
        const captured = source.groupRecipientPeerIds;
        return {
            kind: 'authorized',
            source: {
                ...source,
                groupRecipientPeerIds: audience.filter((peerId) => captured === undefined || captured.includes(peerId))
            }
        };
    }

    async readCurrentDispatchAuthority(
        message: ALMessage
    ): Promise<Extract<WsServerInboundAuthorization, { authorized: true; }> | 'completed' | 'retry'> {
        if (this.#disposed) {
            return 'retry';
        }
        if (isRoomScopedALMessage(message) && !this.#authorizer) {
            return 'completed';
        }
        const validation = this.#validateInboundMessage(message);
        if (validation.left) {
            return 'completed';
        }
        const authorization = await this.#authorizer?.authorize(message) ?? { authorized: true };
        if (this.#disposed) {
            return 'retry';
        }
        if (authorization.authorized) {
            return authorization;
        }
        return authorization.reason === 'not-yet-in-sync' ? 'retry' : 'completed';
    }

    async rejectIncomingMessage(
        message: ALMessage,
        authorization: Extract<WsServerInboundAuthorization, { authorized: false; }>
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        await this.sendAdvisoryNack(message, authorization);
        if (authorization.reason !== 'not-yet-in-sync') {
            return Either.ofLeft({
                code: authorization.rejectionCode ?? 'unauthorized',
                message: authorization.logMessage
            });
        }
        return Either.ofRight({ kind: 'not-admitted', reason: authorization.reason });
    }

    private async sendAdvisoryNack(
        message: ALMessage,
        authorization: Extract<WsServerInboundAuthorization, { authorized: false; }>
    ): Promise<void> {
        if (!authorization.sendNack) {
            return;
        }
        const observedAtEpochMs = this.#clock.nowMs();
        const payload: ALNackPayload = {
            fromPeerId: this.#serverPeerId,
            toPeerId: message.id.senderId,
            msgId: message.id.msgId,
            reason: authorization.reason,
            observedAtEpochMs,
            ...(authorization.serverSnapshotVersion === undefined
                ? {}
                : { serverSnapshotVersion: authorization.serverSnapshotVersion })
        };
        const prepared = prepareALNackControlMessage(
            { v: 2, msgId: this.#newControlId(), senderId: this.#serverPeerId, ts: observedAtEpochMs },
            payload
        );
        if (prepared.right) {
            await this.#controlDelivery.sendControlMessage(prepared.right);
        }
    }
}

function toFinishedRejection(rejection: ALMessageRejection): WsQueueBoxServerInboundAuthority.FinishedDecision {
    return { kind: 'finished', result: Either.ofLeft(rejection) };
}

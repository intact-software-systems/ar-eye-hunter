import {
    AL_MESSAGE_ENVELOPE_VERSION,
    isRoomScopedALMessage,
    type ALMessage
} from '../../al-contracts/al-contract.ts';
import {
    prepareALNackControlMessage,
    type ALAckPayload,
    type ALNackPayload
} from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import {
    readALInboundMessageAuthorization,
    toALInboundReceiver
} from '../../alm/inbound/read-al-inbound-message-authorization.ts';
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
import type { WsQueueBoxServerReceiptSocketFacts } from './ws-queue-box-server-receipt-observation.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

interface WsQueueBoxServerInboundScopeDecision {
    readonly authorization: WsQueueBoxServerScopeAuthorization;
    readonly proof: WsServerInboundConnectionScopeProof | undefined;
    readonly nowMs: number;
}

export namespace WsQueueBoxServerInboundAuthority {
    export interface CurrentnessRejection {
        readonly stage: 'post-authorizer-currentness' | 'admission-currentness';
        readonly failedGuards: readonly ['connection-replaced' | 'connection-closed'];
    }
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly observesReceipts?: boolean;
        readonly serverPeerId: string;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly newControlId: () => string;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly controlDelivery: WsQueueBoxServerControlDelivery;
        readonly ackRelay: WsQueueBoxServerAckRelay;
        readonly authorizeInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        readonly readAuthenticatedConnectionScope:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    }

    export interface AuthorizedMessage {
        readonly message: ALMessage;
        readonly fromPeerId: string;
        readonly authorization: Extract<WsServerInboundAuthorization, { authorized: true; }>;
        readonly proof: WsServerInboundConnectionScopeProof;
        readonly socketFacts: WsQueueBoxServerReceiptSocketFacts | undefined;
    }

    export interface SocketOrigin {
        readonly message: ALMessage;
        readonly connection: ConnectionContext;
        readonly fromPeerId: string;
        readonly socketFacts: WsQueueBoxServerReceiptSocketFacts | undefined;
    }

    export interface AuthorizedCandidate {
        readonly origin: SocketOrigin;
        readonly authorization: Extract<WsServerInboundAuthorization, { authorized: true; }>;
    }

    export interface FinishedDecision {
        readonly kind: 'finished';
        readonly result: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>;
        readonly socketFacts?: WsQueueBoxServerReceiptSocketFacts;
        readonly currentnessRejection?: CurrentnessRejection;
    }

    export type SocketOriginDecision = { readonly kind: 'origin'; readonly value: SocketOrigin; } | FinishedDecision;

    /** A room message its authority is behind on: retained, never refused, as its sender retries nothing. */
    export interface RetainDecision {
        readonly kind: 'retain';
        readonly message: ALMessage;
        readonly source: Extract<ALInboundMessageRuntime.Source, { kind: 'ws-client'; }>;
        readonly socketFacts: WsQueueBoxServerReceiptSocketFacts | undefined;
    }

    export type SocketAdmissionDecision =
        | { readonly kind: 'candidate'; readonly value: AuthorizedCandidate; }
        | RetainDecision
        | FinishedDecision;

    export type AdmissionDecision =
        | { readonly kind: 'authorized'; readonly value: AuthorizedMessage; }
        | {
            readonly kind: 'refused';
            readonly message: ALMessage;
            readonly refusal: WsQueueBoxServerScopeRefusal;
            readonly socketFacts: WsQueueBoxServerReceiptSocketFacts | undefined;
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
    readonly #authorizeInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
    readonly #readAuthenticatedConnectionScope:
        WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    readonly #observesReceipts: boolean;
    #authorizer: WsServerInboundAuthorizer | undefined;
    #disposed = false;

    constructor(dependencies: WsQueueBoxServerInboundAuthority.Dependencies) {
        this.#socket = dependencies.socket;
        this.#observesReceipts = dependencies.observesReceipts === true;
        this.#serverPeerId = dependencies.serverPeerId;
        this.#clock = dependencies.clock;
        this.#newControlId = dependencies.newControlId;
        this.#targetResolution = dependencies.targetResolution;
        this.#controlDelivery = dependencies.controlDelivery;
        this.#ackRelay = dependencies.ackRelay;
        this.#authorizeInboundMessage = dependencies.authorizeInboundMessage;
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
                }),
                socketFacts: origin.value.socketFacts
            };
        }
        const authorization = toWsQueueBoxServerAddresseeAuthorization({
            message,
            serverPeerId: this.#serverPeerId,
            sendNack: this.#authorizer?.sendNacks ?? false,
            authorization: await this.#authorizer?.authorize(message) ?? { authorized: true }
        });
        const current = this.readCurrentConnectionRefusal(
            connectionId,
            origin.value.connection,
            'post-authorizer-currentness'
        );
        if (current) {
            return { ...current, socketFacts: origin.value.socketFacts };
        }
        if (!authorization.authorized) {
            return authorization.reason === 'not-yet-in-sync'
                ? await this.readRetainDecision(origin.value, authorization)
                : {
                    kind: 'finished',
                    result: await this.rejectIncomingMessage(message, authorization),
                    socketFacts: origin.value.socketFacts
                };
        }
        return { kind: 'candidate', value: { origin: origin.value, authorization } };
    }

    /** The scope it is retained under is proven after authorization; the advisory NACK still answers the sender. */
    private async readRetainDecision(
        origin: WsQueueBoxServerInboundAuthority.SocketOrigin,
        authorization: Extract<WsServerInboundAuthorization, { authorized: false; }>
    ): Promise<WsQueueBoxServerInboundAuthority.SocketAdmissionDecision> {
        const { message, connection, fromPeerId } = origin;
        const scope = this.readScopeAuthorization(message, connection);
        const socketFacts = this.toSocketFacts(fromPeerId, scope);
        if (!scope.authorization.authorized) {
            return {
                kind: 'finished',
                result: await this.rejectIncomingMessage(message, scope.authorization),
                socketFacts
            };
        }
        await this.sendAdvisoryNack(message, authorization);
        const { applicationId, workspaceId } = scope.authorization.proof.scope;
        return {
            kind: 'retain',
            message,
            source: { kind: 'ws-client', peerId: fromPeerId, authenticatedScope: { applicationId, workspaceId } },
            socketFacts
        };
    }

    resolveAuthorizedSocketAdmission(
        candidate: WsQueueBoxServerInboundAuthority.AuthorizedCandidate,
        connectionId: string
    ): WsQueueBoxServerInboundAuthority.AdmissionDecision {
        const { message, connection, fromPeerId } = candidate.origin;
        const current = this.readCurrentConnectionRefusal(connectionId, connection, 'admission-currentness');
        if (current) {
            return { ...current, socketFacts: candidate.origin.socketFacts };
        }
        const scope = this.readScopeAuthorization(message, connection);
        const socketFacts = this.toSocketFacts(fromPeerId, scope);
        if (!scope.authorization.authorized) {
            return { kind: 'refused', message, refusal: scope.authorization, socketFacts };
        }
        return {
            kind: 'authorized',
            value: {
                message,
                fromPeerId,
                authorization: candidate.authorization,
                proof: scope.authorization.proof,
                socketFacts
            }
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
            return {
                ...toFinishedRejection({
                    code: 'unauthorized',
                    message: 'AL origin must match an authenticated live WS connection'
                }),
                socketFacts: this.#observesReceipts
                    ? {
                        fromPeerId,
                        authenticatedScope: undefined,
                        scopeDisposition: 'unobserved',
                        scopeAtEpochMs: undefined
                    }
                    : undefined
            };
        }
        const scope = this.readScopeAuthorization(message, connection);
        const socketFacts = this.toSocketFacts(fromPeerId, scope);
        if (!scope.authorization.authorized) {
            return {
                kind: 'finished',
                result: await this.rejectIncomingMessage(message, scope.authorization),
                socketFacts
            };
        }
        const protocolAuthorization = readALInboundMessageAuthorization(
            message,
            { kind: 'ws-client', peerId: fromPeerId, authenticatedScope: scope.authorization.proof.scope },
            toALInboundReceiver(
                this.#serverPeerId,
                (ack, controlIdentity) => this.readIngressProtocolAckRejection(ack, controlIdentity)
            )
        );
        if (protocolAuthorization.left) {
            return { ...toFinishedRejection(protocolAuthorization.left), socketFacts };
        }
        const applicationAuthorization = this.#authorizeInboundMessage(message);
        if (applicationAuthorization.left) {
            return { ...toFinishedRejection(applicationAuthorization.left), socketFacts };
        }
        return { kind: 'origin', value: { message, connection, fromPeerId, socketFacts } };
    }

    private readIngressProtocolAckRejection(
        ack: ALAckPayload,
        controlIdentity?: ALMessage['id']
    ): ALMessageRejection | undefined {
        return this.#ackRelay.readRelayedAckRejection(
            ack,
            !this.#observesReceipts ? undefined : { stage: 'ingress-protocol', controlIdentity }
        );
    }

    private readScopeAuthorization(
        message: ALMessage,
        connection: ConnectionContext
    ): WsQueueBoxServerInboundScopeDecision {
        const proof = this.#readAuthenticatedConnectionScope(connection);
        const nowMs = this.#clock.nowMs();
        const authorization = toWsQueueBoxServerScopeAuthorization({
            message,
            proof,
            nowMs,
            sendNack: this.#authorizer?.sendNacks ?? false
        });
        return { authorization, proof, nowMs };
    }

    private toSocketFacts(
        fromPeerId: string,
        scope: WsQueueBoxServerInboundScopeDecision
    ): WsQueueBoxServerReceiptSocketFacts | undefined {
        return !this.#observesReceipts ? undefined : Object.freeze({
            fromPeerId,
            authenticatedScope: scope.proof === undefined
                ? undefined
                : Object.freeze({
                    applicationId: scope.proof.scope.applicationId,
                    workspaceId: scope.proof.scope.workspaceId
                }),
            scopeDisposition: scope.authorization.authorized ? 'authorized' : 'refused',
            scopeAtEpochMs: scope.nowMs
        });
    }

    private readCurrentConnectionRefusal(
        connectionId: string,
        connection: ConnectionContext,
        stage: WsQueueBoxServerInboundAuthority.CurrentnessRejection['stage']
    ): WsQueueBoxServerInboundAuthority.FinishedDecision | undefined {
        if (this.#disposed) {
            return { kind: 'finished', result: Either.ofRight({ kind: 'disposed' }) };
        }
        const guard = this.#socket.connections.get(connectionId) !== connection
            ? 'connection-replaced'
            : !connection.isOpen
            ? 'connection-closed'
            : undefined;
        if (guard === undefined) {
            return undefined;
        }
        const rejection = toFinishedRejection({
            code: 'unauthorized',
            message: 'WS connection changed during authorization'
        });
        return !this.#observesReceipts ? rejection : {
            ...rejection,
            currentnessRejection: Object.freeze({ stage, failedGuards: Object.freeze([guard] as const) })
        };
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
        const applicationAuthorization = this.#authorizeInboundMessage(message);
        if (applicationAuthorization.left) {
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
        return Either.ofLeft({
            code: authorization.rejectionCode ?? 'unauthorized',
            message: authorization.logMessage
        });
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
            {
                v: AL_MESSAGE_ENVELOPE_VERSION,
                msgId: this.#newControlId(),
                senderId: this.#serverPeerId,
                ts: observedAtEpochMs,
                traceId: message.id.traceId
            },
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

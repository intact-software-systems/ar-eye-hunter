import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import type {
    WsServerInboundConnectionScopeReader,
    WsServerLiveSendInputDto,
    WsServerResolvedRecipient
} from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerRecipientSelection {
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly readAuthenticatedConnectionScope:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    }
}

/** Selects live sockets and verifies their current authenticated audience at the send boundary. */
export class WsQueueBoxServerRecipientSelection {
    readonly #socket: JsonWebSocketServer;
    readonly #clock: ALOutboundMessageRuntime.Clock;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #readAuthenticatedConnectionScope:
        WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];

    constructor(dependencies: WsQueueBoxServerRecipientSelection.Dependencies) {
        this.#socket = dependencies.socket;
        this.#clock = dependencies.clock;
        this.#targetResolution = dependencies.targetResolution;
        this.#readAuthenticatedConnectionScope = dependencies.readAuthenticatedConnectionScope;
    }

    resolveLiveRecipients(input: WsServerLiveSendInputDto): readonly WsServerResolvedRecipient[] {
        const { message, recipientSessionIds, admittedPeerIds, inboundScope, recipientPrincipalId } = input;
        // Explicit authority, including an empty audience, replaces cache-based target resolution.
        const currentRecipients = recipientSessionIds === undefined
            ? this.#targetResolution.resolveOutboundRecipients(message)
            : this.#targetResolution.resolveCapturedSessionRecipients(message, recipientSessionIds);
        const admitted = admittedPeerIds === undefined ? undefined : new Set(admittedPeerIds);
        const admittedRecipients = admitted === undefined
            ? currentRecipients
            : currentRecipients.filter((recipient) => admitted.has(recipient.peerId));
        const requiredScope = input.recipientScope ?? (message.targets?.mode === 'unicast' ? inboundScope : undefined);
        const requiresAuthentication = input.requireAuthenticatedRecipient === true ||
            input.recipientScope !== undefined ||
            (message.targets?.mode === 'unicast' && inboundScope !== undefined);
        return !requiresAuthentication && requiredScope === undefined
            ? admittedRecipients
            : admittedRecipients.filter((recipient) =>
                requiredScope !== null && this.isCurrentAuthorized(recipient, requiredScope, recipientPrincipalId)
            );
    }

    isCurrentAuthorized(
        recipient: WsServerResolvedRecipient,
        scope: StateScope | undefined,
        principalId?: string
    ): boolean {
        const connection = this.#socket.connections.get(recipient.connectionId);
        if (!connection?.isOpen) {
            return false;
        }
        const proof = this.#readAuthenticatedConnectionScope(connection);
        return proof !== undefined && proof.expiresAtEpochMs > this.#clock.nowMs() &&
            (scope === undefined ||
                (proof.scope.applicationId === scope.applicationId && proof.scope.workspaceId === scope.workspaceId)) &&
            (principalId === undefined || proof.principalId === principalId);
    }
}

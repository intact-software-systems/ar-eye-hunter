import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import { resolveWsQueueBoxServerProvenScope } from './scope/resolve-ws-queue-box-server-recipient-scope.ts';
import type {
    WsServerInboundConnectionScopeReader,
    WsServerLiveSendFailure,
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
        if (input.accountView !== undefined) {
            return [...this.#socket.connections.values()]
                .map((connection) => ({ peerId: connection.id, connectionId: connection.id }))
                .filter((recipient) => this.isCurrentAuthorized(recipient, undefined, input.accountView!.principalId));
        }
        // Explicit authority, including an empty audience, replaces cache-based target resolution.
        const frozenSessionIds = recipientSessionIds ??
            (this.#targetResolution.requiresFrozenAudience(message) ? admittedPeerIds ?? [] : undefined);
        const currentRecipients = frozenSessionIds === undefined
            ? this.#targetResolution.resolveOutboundRecipients(message)
            : this.#targetResolution.resolveCapturedSessionRecipients(message, frozenSessionIds);
        const admitted = admittedPeerIds === undefined ? undefined : new Set(admittedPeerIds);
        const captured = input.roomSessionGenerations;
        const admittedRecipients = currentRecipients.filter((recipient) => {
            if (admitted !== undefined && !admitted.has(recipient.peerId)) {
                return false;
            }
            if (captured === undefined) {
                return true;
            }
            const generation = this.#socket.connections.get(recipient.connectionId)?.generationId;
            return recipient.connectionId === recipient.peerId && generation !== undefined &&
                Object.hasOwn(captured, recipient.connectionId) && captured[recipient.connectionId] === generation;
        });
        const provenScope = resolveWsQueueBoxServerProvenScope(message, inboundScope);
        const requiredScope = input.recipientScope ?? provenScope;
        const requiresAuthentication = input.requireAuthenticatedRecipient === true ||
            input.recipientScope !== undefined || provenScope !== undefined;
        return !requiresAuthentication && requiredScope === undefined
            ? admittedRecipients
            : admittedRecipients.filter((recipient) =>
                requiredScope !== null && this.isCurrentAuthorized(recipient, requiredScope, recipientPrincipalId)
            );
    }

    /** A subscriber cannot reject the publisher's completed NOTIFY. Reopening repairs from canonical state. */
    closeFailedRoomSnapshotConnections(
        failures: readonly WsServerLiveSendFailure[],
        captured: Readonly<Record<string, string>>
    ): void {
        for (const { connectionId } of failures) {
            const generation = this.#socket.connections.get(connectionId)?.generationId;
            if (
                generation !== undefined && Object.hasOwn(captured, connectionId) &&
                generation === captured[connectionId]
            ) {
                this.#socket.closeConnection(connectionId, 1011, 'Room snapshot delivery failed');
            }
        }
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

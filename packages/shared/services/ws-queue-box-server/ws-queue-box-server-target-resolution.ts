import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { JsonWebSocketServer } from '../../websocket/JsonWebSocketServer.ts';
import type { WsServerResolvedRecipient, WsServerTargetResolver } from './ws-queue-box-server-contracts.ts';

export namespace WsQueueBoxServerTargetResolution {
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly targetResolver: WsServerTargetResolver;
    }
}

export class WsQueueBoxServerTargetResolution {
    readonly #socket: JsonWebSocketServer;
    readonly #targetResolver: WsServerTargetResolver;

    constructor(dependencies: WsQueueBoxServerTargetResolution.Dependencies) {
        this.#socket = dependencies.socket;
        this.#targetResolver = dependencies.targetResolver;
    }

    resolvePeerIdForConnection(connectionId: string, message: ALMessage): string {
        return this.#targetResolver.resolvePeerIdForConnection?.(connectionId, message) ??
            connectionId;
    }

    resolveOutboundRecipients(message: ALMessage): readonly WsServerResolvedRecipient[] {
        const targets = message.targets;
        if (!targets) {
            return [];
        }

        switch (targets.mode) {
            case 'unicast':
                return this.resolvePeerRecipients(targets.toPeerId, message);
            case 'multicast':
                return deduplicateRecipients(
                    this.#targetResolver.resolveGroupRecipients?.(
                        targets.groupRef.groupId,
                        message
                    ) ?? []
                );
            case 'broadcast': {
                const recipients = this.#targetResolver.resolveBroadcastRecipients?.(
                    targets.scope,
                    message
                ) ?? this.toDefaultBroadcastRecipients(targets.exceptPeerIds);
                return deduplicateRecipients(
                    recipients.filter(
                        (recipient) => !targets.exceptPeerIds?.includes(recipient.peerId)
                    )
                );
            }
        }
    }

    resolveInboundRecipients(message: ALMessage): readonly WsServerResolvedRecipient[] {
        const targets = message.targets;
        if (!targets) {
            return [];
        }

        switch (targets.mode) {
            case 'unicast':
                return deduplicateRecipients(
                    this.#targetResolver.resolvePeerRecipients?.(
                        targets.toPeerId,
                        message
                    ) ?? []
                );
            case 'multicast':
                return deduplicateRecipients(
                    this.#targetResolver.resolveGroupRecipients?.(
                        targets.groupRef.groupId,
                        message
                    ) ?? []
                );
            case 'broadcast':
                return deduplicateRecipients(
                    this.#targetResolver.resolveBroadcastRecipients?.(
                        targets.scope,
                        message
                    ).filter(
                        (recipient) => !targets.exceptPeerIds?.includes(recipient.peerId)
                    ) ?? []
                );
        }
    }

    resolveRepairRecipients(
        message: ALMessage,
        peerIds: readonly string[]
    ): readonly WsServerResolvedRecipient[] {
        if (peerIds.length === 0) {
            return [];
        }

        return deduplicateRecipients(
            peerIds.flatMap((peerId) => this.resolvePeerRecipients(peerId, message))
        );
    }

    private resolvePeerRecipients(
        peerId: string,
        message: ALMessage
    ): readonly WsServerResolvedRecipient[] {
        return this.#targetResolver.resolvePeerRecipients
            ? deduplicateRecipients(this.#targetResolver.resolvePeerRecipients(peerId, message))
            : [{ peerId, connectionId: peerId }];
    }

    private toDefaultBroadcastRecipients(
        exceptPeerIds?: readonly string[]
    ): readonly WsServerResolvedRecipient[] {
        if (!(this.#socket.connections instanceof Map)) {
            return [];
        }

        return [...this.#socket.connections.values()]
            .filter((connection) => connection.isOpen && !exceptPeerIds?.includes(connection.id))
            .map((connection) => ({
                peerId: connection.id,
                connectionId: connection.id
            }));
    }
}

function deduplicateRecipients(
    recipients: readonly WsServerResolvedRecipient[]
): readonly WsServerResolvedRecipient[] {
    const byConnectionId = new Map<string, WsServerResolvedRecipient>();
    for (const recipient of recipients) {
        byConnectionId.set(recipient.connectionId, recipient);
    }
    return [...byConnectionId.values()];
}

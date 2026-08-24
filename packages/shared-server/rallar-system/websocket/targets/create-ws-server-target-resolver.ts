import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { WsServerResolvedRecipient, WsServerTargetResolver } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RallarGroupSnapshotResolverOptions } from '../../middleware/rallar-middleware-options.ts';
import { resolveWsClientTargetRecipients } from './resolve-ws-client-target.ts';
import { resolveWsCrdtPrincipalTargetRecipients } from './resolve-ws-crdt-principal-target.ts';
import { resolveWsFixedTopologyTargetRecipients } from './resolve-ws-fixed-topology-target-recipients.ts';
import { resolveWsGroupTargetRecipients } from './resolve-ws-group-target.ts';

export function createWsServerTargetResolver(
    webSocketServer: JsonWebSocketServer,
    options: RallarGroupSnapshotResolverOptions = {}
): WsServerTargetResolver {
    const resolveGroupRecipients = (
        groupId: string,
        message: ALMessage
    ): readonly WsServerResolvedRecipient[] =>
        resolveWsGroupTargetRecipients({
            groupId,
            message,
            webSocketServer,
            options
        });

    return {
        resolvePeerRecipients: (peerId, message) => {
            const principalRecipients = resolveWsCrdtPrincipalTargetRecipients({
                principalId: peerId,
                message,
                webSocketServer,
                options
            });
            if (principalRecipients !== undefined) {
                return principalRecipients;
            }
            const connection = webSocketServer.connections.get(peerId);
            return connection?.isOpen ? [{ peerId, connectionId: peerId }] : [];
        },
        resolveGroupRecipients,
        resolveBroadcastRecipients: (scope, message) => {
            const fixedRecipients = resolveWsFixedTopologyTargetRecipients(
                webSocketServer,
                message
            );
            if (fixedRecipients !== undefined) {
                return fixedRecipients;
            }
            if (scope === 'room') {
                return resolveGroupRecipients(
                    readALTargetGroupRef(message)?.groupId ?? message.route.contextId,
                    message
                );
            }
            const clientRecipients = resolveWsClientTargetRecipients({
                message,
                webSocketServer,
                options
            });
            return clientRecipients ?? [...webSocketServer.connections.values()]
                .filter((context) => context.isOpen)
                .map((context) => ({ peerId: context.id, connectionId: context.id }));
        },
        resolvePeerIdForConnection: (connectionId) => connectionId
    };
}

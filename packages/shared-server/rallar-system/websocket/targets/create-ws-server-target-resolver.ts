import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type {
    WsServerResolvedRecipient,
    WsServerTargetResolver
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { resolveWsClientTargetRecipients } from './resolve-ws-client-target.ts';
import { resolveWsCrdtPrincipalTargetRecipients } from './resolve-ws-crdt-principal-target.ts';
import { resolveWsFixedTopologyTargetRecipients } from './resolve-ws-fixed-topology-target-recipients.ts';
import { resolveWsGroupTargetRecipients } from './resolve-ws-group-target.ts';
import type { WsServerTargetResolutionOptions } from './ws-server-target-resolution-options.ts';

interface ResolveBroadcastRecipientsInput {
    readonly scope: 'room' | 'world' | 'all' | 'principal';
    readonly message: ALMessage;
    readonly webSocketServer: JsonWebSocketServer;
    readonly options: WsServerTargetResolutionOptions;
}

export function createWsServerTargetResolver(
    webSocketServer: JsonWebSocketServer,
    options: WsServerTargetResolutionOptions = {}
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
        resolveBroadcastRecipients: (scope, message) =>
            resolveBroadcastRecipients({ scope, message, webSocketServer, options }),
        resolvePeerIdForConnection: (connectionId) => connectionId
    };
}

function resolveBroadcastRecipients(input: ResolveBroadcastRecipientsInput): readonly WsServerResolvedRecipient[] {
    const { scope, message, webSocketServer, options } = input;
    const fixedRecipients = resolveWsFixedTopologyTargetRecipients(webSocketServer, message);
    if (fixedRecipients !== undefined) {
        return fixedRecipients;
    }
    if (scope === 'room') {
        return resolveWsGroupTargetRecipients({
            groupId: readALTargetGroupRef(message)?.groupId ?? message.route.contextId,
            message,
            webSocketServer,
            options
        });
    }
    const clientRecipients = resolveWsClientTargetRecipients({ message, webSocketServer, options });
    return clientRecipients ?? [...webSocketServer.connections.values()]
        .filter((context) => context.isOpen)
        .map((context) => ({ peerId: context.id, connectionId: context.id }));
}

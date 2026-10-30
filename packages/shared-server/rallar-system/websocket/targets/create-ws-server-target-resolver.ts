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

/** A granted topic's message is never resolved from its targets, on any branch: only its frozen audience is sent to. */
export function createWsServerTargetResolver(
    webSocketServer: JsonWebSocketServer,
    options: WsServerTargetResolutionOptions
): WsServerTargetResolver {
    const requiresFrozenAudience = (message: ALMessage) => options.grantedTopics.has(message.route.topicId);
    return {
        resolvePeerRecipients: (peerId, message) =>
            requiresFrozenAudience(message) ? [] : resolvePeerRecipients({ peerId, message, webSocketServer, options }),
        resolveGroupRecipients: (groupId, message) =>
            requiresFrozenAudience(message)
                ? []
                : resolveWsGroupTargetRecipients({ groupId, message, webSocketServer, options }),
        resolveBroadcastRecipients: (scope, message) =>
            requiresFrozenAudience(message)
                ? []
                : resolveBroadcastRecipients({ scope, message, webSocketServer, options }),
        resolvePeerIdForConnection: (connectionId) => connectionId,
        requiresFrozenAudience
    };
}

interface ResolvePeerRecipientsInput {
    readonly peerId: string;
    readonly message: ALMessage;
    readonly webSocketServer: JsonWebSocketServer;
    readonly options: WsServerTargetResolutionOptions;
}

function resolvePeerRecipients(input: ResolvePeerRecipientsInput): readonly WsServerResolvedRecipient[] {
    const { peerId, message, webSocketServer, options } = input;
    const principalRecipients = resolveWsCrdtPrincipalTargetRecipients({
        principalId: peerId,
        message,
        webSocketServer,
        options
    });
    if (principalRecipients !== undefined) {
        return principalRecipients;
    }
    return webSocketServer.connections.get(peerId)?.isOpen ? [{ peerId, connectionId: peerId }] : [];
}

function resolveBroadcastRecipients(input: ResolveBroadcastRecipientsInput): readonly WsServerResolvedRecipient[] {
    const { scope, message, webSocketServer, options } = input;
    const fixedRecipients = resolveWsFixedTopologyTargetRecipients(webSocketServer, message);
    if (fixedRecipients !== undefined) {
        return fixedRecipients;
    }
    const groupRef = readALTargetGroupRef(message);
    if (scope === 'room' || groupRef !== undefined) {
        return resolveWsGroupTargetRecipients({
            groupId: groupRef?.groupId ?? message.route.contextId,
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

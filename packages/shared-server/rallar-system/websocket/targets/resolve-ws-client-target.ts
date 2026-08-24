import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { WsServerResolvedRecipient } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RallarGroupSnapshotResolverOptions } from '../../middleware/rallar-middleware-options.ts';
import { resolveStateSyncRecipients } from '../../state-sync/state-sync-routing.ts';

export interface ResolveWsClientTargetInput {
    readonly message: ALMessage;
    readonly webSocketServer: JsonWebSocketServer;
    readonly options: RallarGroupSnapshotResolverOptions;
}

export function resolveWsClientTargetRecipients(
    input: ResolveWsClientTargetInput
): readonly WsServerResolvedRecipient[] | undefined {
    return resolveStateSyncRecipients(input.webSocketServer, input.message, {
        findGroupSnapshotByRef: (ref) => input.options.findGroupSnapshotByRef?.(ref, input.message),
        findGroupSnapshotById: input.options.findGroupSnapshotById,
        now: input.options.now
    });
}

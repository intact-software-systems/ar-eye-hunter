import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { resolveStateSyncRecipients } from '../../state-sync/state-sync-routing.ts';
import type { WsServerTargetResolutionOptions } from './ws-server-target-resolution-options.ts';

export interface ResolveWsClientTargetInput {
    readonly message: ALMessage;
    readonly webSocketServer: JsonWebSocketServer;
    readonly options: WsServerTargetResolutionOptions;
}

export function resolveWsClientTargetRecipients(
    input: ResolveWsClientTargetInput
): readonly WsServerResolvedRecipient[] | undefined {
    return resolveStateSyncRecipients(input.webSocketServer, input.message, {
        findGroupSnapshotByRef: (ref) => input.options.findGroupSnapshotByRef?.(ref, input.message),
        findClientSnapshotByRef: input.options.findClientSnapshotByRef
            ? (ref) => input.options.findClientSnapshotByRef?.(ref, input.message)
            : undefined,
        now: input.options.now
    });
}

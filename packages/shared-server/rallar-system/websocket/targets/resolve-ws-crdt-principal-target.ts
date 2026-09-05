import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { RALLAR_CRDT_UPDATE_TYPE_ID } from '@shared/crdt/mod.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { isClientSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type {
    RallarCrdtPrincipalSnapshotRef,
    WsServerTargetResolutionOptions
} from './ws-server-target-resolution-options.ts';

export interface ResolveWsCrdtPrincipalTargetInput {
    readonly principalId: string;
    readonly message: ALMessage;
    readonly webSocketServer: JsonWebSocketServer;
    readonly options: WsServerTargetResolutionOptions;
}

export function resolveWsCrdtPrincipalTargetRecipients(
    input: ResolveWsCrdtPrincipalTargetInput
): readonly WsServerResolvedRecipient[] | undefined {
    const principalRef = readCrdtPrincipalRef(input.message, input.principalId);
    if (!principalRef) {
        return undefined;
    }
    const snapshot = input.options.findClientSnapshotByRef?.(
        principalRef,
        input.message
    );
    if (
        !snapshot ||
        snapshot.principal.applicationId !== principalRef.applicationId ||
        snapshot.principal.principalId !== principalRef.principalId ||
        (principalRef.workspaceId !== undefined && snapshot.principal.workspaceId !== principalRef.workspaceId)
    ) {
        return [];
    }
    const nowEpochMs = input.options.now?.() ?? Date.now();
    return snapshot.activeSessions
        .filter((session) =>
            isClientSnapshotSessionLive(session, nowEpochMs) &&
            input.webSocketServer.connections.get(session.connectionId ?? session.sessionId)?.isOpen
        )
        .map((session) => ({
            peerId: session.sessionId,
            connectionId: session.connectionId ?? session.sessionId
        }));
}

function readCrdtPrincipalRef(
    message: ALMessage,
    principalId: string
): RallarCrdtPrincipalSnapshotRef | undefined {
    if (message.payload.typeId !== RALLAR_CRDT_UPDATE_TYPE_ID) {
        return undefined;
    }
    try {
        const value = decodeJsonWireValue(
            JSON.parse(message.payload.resource)
        );
        const document = isJsonWireObject(value) && isJsonWireObject(value.document) ? value.document : undefined;
        if (!document) {
            return undefined;
        }
        if (
            document.scope !== 'principal' ||
            document.principalId !== principalId ||
            typeof document.applicationId !== 'string' ||
            (document.workspaceId !== undefined && typeof document.workspaceId !== 'string')
        ) {
            return undefined;
        }
        return document.workspaceId !== undefined
            ? {
                applicationId: document.applicationId,
                workspaceId: document.workspaceId,
                principalId
            }
            : {
                applicationId: document.applicationId,
                principalId
            };
    }
    catch {
        return undefined;
    }
}

function isJsonWireObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

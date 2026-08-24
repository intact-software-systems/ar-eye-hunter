import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { compareGroupCausalRevision, readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { WsServerResolvedRecipient } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RallarGroupSnapshotResolverOptions } from '../../middleware/rallar-middleware-options.ts';
import { isGroupSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import { decodeStateSyncMessage, type StateSyncDecodeResult } from '../../state-sync/state-sync-payload.ts';

export interface ResolveWsGroupTargetInput {
    readonly groupId: string;
    readonly message: ALMessage;
    readonly webSocketServer: JsonWebSocketServer;
    readonly options: RallarGroupSnapshotResolverOptions;
}

export function resolveWsGroupTargetRecipients(
    input: ResolveWsGroupTargetInput
): readonly WsServerResolvedRecipient[] {
    const decoded = decodeStateSyncMessage(input.message);
    if (decoded.kind === 'invalid') {
        return [];
    }
    const audienceSessionIds = readGroupAudience(input.groupId, decoded);
    if (audienceSessionIds) {
        return audienceSessionIds
            .filter((sessionId) => input.webSocketServer.connections.get(sessionId)?.isOpen)
            .map((sessionId) => ({ peerId: sessionId, connectionId: sessionId }));
    }

    const snapshot = resolveGroupSnapshot(input, decoded);
    if (!snapshot) {
        return [];
    }
    const nowEpochMs = input.options.now?.() ?? Date.now();
    return snapshot.activeSessions
        .filter((session) =>
            isGroupSnapshotSessionLive(session, nowEpochMs) &&
            input.webSocketServer.connections.get(session.sessionId)?.isOpen
        )
        .map((session) => ({
            peerId: session.sessionId,
            connectionId: session.sessionId
        }));
}

function resolveGroupSnapshot(
    input: ResolveWsGroupTargetInput,
    decoded: StateSyncDecodeResult
): GroupSnapshot | undefined {
    const groupRef = readALTargetGroupRef(input.message) ??
        input.options.resolveGroupRef?.(input.groupId, input.message);
    const scopedSnapshot = groupRef
        ? input.options.findGroupSnapshotByRef?.(groupRef, input.message)
        : undefined;
    const knownSnapshot = scopedSnapshot ?? resolveGroupSnapshotById(input, groupRef);
    const payloadSnapshot = readGroupSnapshot(input.groupId, decoded);
    if (!payloadSnapshot) {
        return knownSnapshot;
    }
    if (!knownSnapshot) {
        return payloadSnapshot;
    }
    return compareGroupCausalRevision(
            readGroupCausalRevision(payloadSnapshot),
            readGroupCausalRevision(knownSnapshot)
        ) === 'dominated'
        ? knownSnapshot
        : payloadSnapshot;
}

function resolveGroupSnapshotById(
    input: ResolveWsGroupTargetInput,
    groupRef: ReturnType<typeof readALTargetGroupRef>
): GroupSnapshot | undefined {
    const snapshot = input.options.findGroupSnapshotById?.(input.groupId);
    if (!snapshot) {
        return undefined;
    }
    return groupRef === undefined || isSameGroupScope(snapshot.group, groupRef)
        ? snapshot
        : undefined;
}

function readGroupSnapshot(
    groupId: string,
    decoded: StateSyncDecodeResult
): GroupSnapshot | undefined {
    if (
        decoded.kind !== 'decoded' ||
        (decoded.payload.kind !== 'group-snapshot' &&
            decoded.payload.kind !== 'group-directory-snapshot')
    ) {
        return undefined;
    }
    return decoded.payload.snapshot.group.groupId === groupId
        ? decoded.payload.snapshot
        : undefined;
}

function readGroupAudience(
    groupId: string,
    decoded: StateSyncDecodeResult
): readonly string[] | undefined {
    return decoded.kind === 'decoded' &&
            decoded.payload.kind === 'group-event' &&
            decoded.payload.envelope.event.groupId === groupId
        ? decoded.payload.envelope.audienceSessionIds
        : undefined;
}

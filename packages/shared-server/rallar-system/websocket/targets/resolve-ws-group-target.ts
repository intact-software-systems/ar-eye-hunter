import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { decodeGroupSnapshotPageRevision, type StateSnapshotPage } from '@shared/api/state-snapshot-page.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { isGroupSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import { filterLiveWsRoomRecipientSessionIds } from '../../queue-pubsub/live-ws-audience.ts';
import { decodeStateSyncMessage } from '../../state-sync/state-sync-payload.ts';
import { resolveWsClientTargetRecipients } from './resolve-ws-client-target.ts';
import type { WsServerTargetResolutionOptions } from './ws-server-target-resolution-options.ts';

export interface ResolveWsGroupTargetInput {
    readonly groupId: string;
    readonly message: ALMessage;
    readonly webSocketServer: JsonWebSocketServer;
    readonly options: WsServerTargetResolutionOptions;
}

export function resolveWsGroupTargetRecipients(
    input: ResolveWsGroupTargetInput
): readonly WsServerResolvedRecipient[] {
    const groupRef = readALTargetGroupRef(input.message);
    if (!groupRef || groupRef.groupId !== input.groupId) {
        return [];
    }
    const decoded = decodeStateSyncMessage(input.message);
    if (decoded.kind === 'invalid') {
        return [];
    }
    if (decoded.kind === 'decoded' && decoded.payload.kind === 'snapshot-page') {
        return resolveSnapshotPageRecipients(input, decoded.payload.page);
    }
    if (decoded.kind === 'decoded' && decoded.payload.kind === 'group-event') {
        return decoded.payload.envelope.audienceSessionIds
            .filter((sessionId) => input.webSocketServer.connections.get(sessionId)?.isOpen)
            .map((sessionId) => ({ peerId: sessionId, connectionId: sessionId }));
    }
    const snapshot = input.options.findGroupSnapshotByRef?.(groupRef, input.message);
    if (!snapshot || !isSameGroupRef(snapshot.group, groupRef)) {
        return [];
    }
    return resolveLiveGroupSessions(input, snapshot);
}

function resolveSnapshotPageRecipients(
    input: ResolveWsGroupTargetInput,
    page: StateSnapshotPage
): readonly WsServerResolvedRecipient[] {
    const targets = input.message.targets;
    const nowMs = input.options.now?.() ?? Date.now();
    const revision = decodeGroupSnapshotPageRevision(page);
    if (
        revision.left || page.expiresAtMs <= nowMs || targets?.mode !== 'broadcast' ||
        targets.scope !== 'room' || !targets.groupRef
    ) {
        return [];
    }
    if (targets.recipientPeerIds === undefined) {
        return resolveWsClientTargetRecipients(input) ?? [];
    }
    const snapshot = input.options.findGroupSnapshotByRef?.(targets.groupRef, input.message);
    if (snapshot && !isSameGroupRef(snapshot.group, targets.groupRef)) {
        return [];
    }
    const order = snapshot ? compareGroupCausalRevision(snapshot.causalRevision, revision.right!) : undefined;
    const currentAudience = snapshot && (order === 'dominates' || order === 'equal')
        ? currentSnapshotAudience(snapshot, nowMs)
        : undefined;
    return targets.recipientPeerIds
        .filter((peerId) =>
            (!currentAudience || currentAudience.has(peerId)) && input.webSocketServer.connections.get(peerId)?.isOpen
        )
        .map((peerId) => ({ peerId, connectionId: peerId }));
}

function currentSnapshotAudience(snapshot: GroupSnapshot, nowMs: number): ReadonlySet<string> {
    const activeMembers = new Set(
        snapshot.members.filter((member) => member.status === 'active').map((member) => member.principalId)
    );
    return new Set(
        snapshot.activeSessions
            .filter((session) => activeMembers.has(session.principalId) && isGroupSnapshotSessionLive(session, nowMs))
            .map((session) => session.sessionId)
    );
}

/** The room's live open sessions the targets address: a principal broadcast names its principal's, a fixed list its own. */
function resolveLiveGroupSessions(
    input: ResolveWsGroupTargetInput,
    snapshot: GroupSnapshot
): readonly WsServerResolvedRecipient[] {
    const { message } = input;
    const targets = message.targets;
    const nowEpochMs = input.options.now?.() ?? Date.now();
    const principalId = targets?.mode === 'broadcast' && targets.scope === 'principal'
        ? targets.principalRef?.principalId
        : undefined;
    const liveSessionIds = snapshot.activeSessions
        .filter((session) =>
            (principalId === undefined || session.principalId === principalId) &&
            isGroupSnapshotSessionLive(session, nowEpochMs) &&
            input.webSocketServer.connections.get(session.sessionId)?.isOpen
        )
        .map((session) => session.sessionId);
    return (targets === undefined
        ? liveSessionIds
        : filterLiveWsRoomRecipientSessionIds(targets, message.id.senderId, liveSessionIds))
        .map((sessionId) => ({ peerId: sessionId, connectionId: sessionId }));
}

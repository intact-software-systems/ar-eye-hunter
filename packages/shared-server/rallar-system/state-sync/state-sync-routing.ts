import { readGroupVisibility } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import {
    isClientSnapshotSessionLive,
    type RallarSnapshotPresenceClock
} from '../presence/snapshot-presence.ts';
import {
    decodeStateSyncMessage,
    sameScope,
    type StateSyncPayload
} from './state-sync-payload.ts';

export interface StateSyncRoutingOptions {
    readonly findGroupSnapshotByRef?: (ref: GroupRef) => GroupSnapshot | undefined;
    readonly findClientSnapshotByRef?: (ref: ClientPrincipalRef) => ClientSnapshot | undefined;
    readonly readClientSnapshots?: () => readonly ClientSnapshot[];
    readonly readGroupSnapshots?: () => readonly GroupSnapshot[];
    readonly now?: RallarSnapshotPresenceClock;
}

export function resolveStateSyncRecipients(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {}
): readonly WsServerResolvedRecipient[] | undefined {
    const decoded = decodeStateSyncMessage(message);
    if (decoded.kind === 'unsupported') {
        return undefined;
    }
    if (decoded.kind === 'invalid') {
        return [];
    }

    return resolveStateSyncPayloadRecipients(webSocketServer, decoded.payload, options);
}

function resolveStateSyncPayloadRecipients(
    webSocketServer: JsonWebSocketServer,
    payload: StateSyncPayload,
    options: StateSyncRoutingOptions
): readonly WsServerResolvedRecipient[] {
    switch (payload.kind) {
        case 'snapshot-page': {
            if (payload.page.expiresAtMs <= (options.now?.() ?? Date.now())) {
                return [];
            }
            if (payload.recipientPeerId) {
                return toOpenConnectionRecipients(webSocketServer, [payload.recipientPeerId]);
            }
            const scope = payload.page.scope;
            if (scope.kind === 'principal') {
                return resolvePrincipalRecipients(webSocketServer, {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    principalId: scope.resourceId
                }, options);
            }
            const ref = {
                applicationId: scope.applicationId,
                workspaceId: scope.workspaceId,
                groupId: scope.resourceId
            };
            const snapshot = options.findGroupSnapshotByRef?.(ref) ??
                (options.readGroupSnapshots?.() ?? groupStateSnapshotsRepository.getAllGroupStateSnapshots())
                    .find((group) => sameScope(group.group, ref) && group.group.groupId === ref.groupId);
            return snapshot && sameScope(snapshot.group, ref) && snapshot.group.groupId === ref.groupId
                ? resolveGroupRecipients(webSocketServer, snapshot, options)
                : [];
        }
        case 'client-event':
            return resolvePrincipalRecipients(
                webSocketServer,
                payload.event,
                options
            );
        case 'group-event':
            return toOpenConnectionRecipients(
                webSocketServer,
                payload.envelope.audienceSessionIds
            );
    }
}

/**
 * Scope 'principal' resolves at delivery time to the principal's own live
 * sessions plus live sessions of groups the principal is an active member of.
 * It never falls through to every open connection.
 */
function resolvePrincipalRecipients(
    webSocketServer: JsonWebSocketServer,
    principalRef: ClientPrincipalRef,
    options: StateSyncRoutingOptions
): readonly WsServerResolvedRecipient[] {
    const ownRecipients = readScopedClientSnapshots([principalRef], options)
        .filter((snapshot) =>
            sameScope(snapshot.principal, principalRef) &&
            snapshot.principal.principalId === principalRef.principalId
        )
        .flatMap((snapshot) => toOpenClientSessionRecipients(webSocketServer, snapshot, options));
    const groupSnapshots = options.readGroupSnapshots?.() ??
        groupStateSnapshotsRepository.getAllGroupStateSnapshots();
    const coGroupRecipients = groupSnapshots
        .filter((snapshot) =>
            sameScope(snapshot.group, principalRef) &&
            snapshot.members.some((member) =>
                member.principalId === principalRef.principalId &&
                member.status === 'active'
            )
        )
        .flatMap((snapshot) => resolveGroupRecipients(webSocketServer, snapshot, options));
    return dedupRecipients([...ownRecipients, ...coGroupRecipients]);
}

function resolveGroupRecipients(
    webSocketServer: JsonWebSocketServer,
    snapshot: GroupSnapshot,
    options: StateSyncRoutingOptions
): readonly WsServerResolvedRecipient[] {
    const now = options.now?.() ?? Date.now();
    const fullReadPrincipalIds = new Set(
        snapshot.members
            .filter((member) =>
                readGroupVisibility({
                    snapshot,
                    actor: { principalId: member.principalId },
                    nowEpochMs: now
                }) === 'full'
            )
            .map((member) => member.principalId)
    );
    const clientSnapshots = readScopedClientSnapshots(
        [...fullReadPrincipalIds].map((principalId) => ({
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            principalId
        })),
        options
    );
    const clientRecipients: WsServerResolvedRecipient[] = [];
    for (const clientSnapshot of clientSnapshots) {
        if (
            !sameScope(clientSnapshot.principal, snapshot.group) ||
            !fullReadPrincipalIds.has(clientSnapshot.principal.principalId)
        ) {
            continue;
        }

        for (const session of clientSnapshot.activeSessions) {
            if (!isClientSnapshotSessionLive(session, now)) {
                continue;
            }

            if (webSocketServer.connections.get(session.sessionId)?.isOpen) {
                clientRecipients.push({
                    peerId: clientSnapshot.principal.principalId,
                    connectionId: session.sessionId
                });
            }
        }
    }
    return dedupRecipients(clientRecipients);
}

function readScopedClientSnapshots(
    principalRefs: readonly ClientPrincipalRef[],
    options: StateSyncRoutingOptions
): readonly ClientSnapshot[] {
    if (options.findClientSnapshotByRef) {
        return principalRefs.flatMap((ref) => {
            const snapshot = options.findClientSnapshotByRef?.(ref);
            return snapshot && sameScope(snapshot.principal, ref) && snapshot.principal.principalId === ref.principalId
                ? [snapshot]
                : [];
        });
    }
    return (options.readClientSnapshots?.() ?? clientStateSnapshotsRepository.getAllClientStateSnapshots())
        .filter((snapshot) =>
            principalRefs.some((ref) =>
                sameScope(snapshot.principal, ref) && snapshot.principal.principalId === ref.principalId
            )
        );
}

/**
 * Delta-envelope rows persist their computed audience at write time; delivery
 * intersects it with locally open connections only. Sessions without a local
 * open connection are dropped silently — late joiners converge through their
 * join-time snapshot pull, never through event fanout.
 */
function toOpenConnectionRecipients(
    webSocketServer: JsonWebSocketServer,
    audienceSessionIds: readonly string[]
): readonly WsServerResolvedRecipient[] {
    return dedupRecipients(
        audienceSessionIds
            .filter((sessionId) => webSocketServer.connections.get(sessionId)?.isOpen)
            .map((sessionId) => ({
                peerId: sessionId,
                connectionId: sessionId
            }))
    );
}

function toOpenClientSessionRecipients(
    webSocketServer: JsonWebSocketServer,
    snapshot: ClientSnapshot,
    options: StateSyncRoutingOptions = {}
): readonly WsServerResolvedRecipient[] {
    const now = options.now?.() ?? Date.now();
    return snapshot.activeSessions
        .filter((session) =>
            isClientSnapshotSessionLive(session, now) &&
            webSocketServer.connections.get(session.sessionId)?.isOpen
        )
        .map((session) => ({
            peerId: snapshot.principal.principalId,
            connectionId: session.sessionId
        }));
}

function dedupRecipients(
    recipients: readonly WsServerResolvedRecipient[]
): readonly WsServerResolvedRecipient[] {
    const byConnectionId = new Map<string, WsServerResolvedRecipient>();
    for (const recipient of recipients) {
        byConnectionId.set(recipient.connectionId, recipient);
    }
    return [...byConnectionId.values()];
}

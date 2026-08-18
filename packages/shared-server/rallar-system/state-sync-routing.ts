import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    readALPrincipalBroadcastTarget,
} from '@shared/al-contracts/read-al-principal-broadcast-target.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { WsServerResolvedRecipient } from '@shared/services/WsQueueBoxServerService.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { readGroupVisibility } from './group-policy.ts';
import {
    isClientSnapshotSessionLive,
    isGroupSnapshotSessionLive,
    type RallarSnapshotPresenceClock,
} from './snapshot-presence.ts';
import {
    parseStateSyncPayload,
    readClientSnapshotStateSyncPayload,
    sameScope,
    type StateSyncScope,
} from './state-sync/state-sync-payload.ts';

export type StateSyncRoutingOptions = Readonly<{
    findGroupSnapshotByRef?: (ref: GroupRef) => GroupSnapshot | undefined;
    findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    readClientSnapshots?: () => readonly ClientSnapshot[];
    readGroupSnapshots?: () => readonly GroupSnapshot[];
    now?: RallarSnapshotPresenceClock;
}>;

export function resolveStateSyncRecipients(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {},
): readonly WsServerResolvedRecipient[] | undefined {
    const principalTarget = readALPrincipalBroadcastTarget(message);
    if (principalTarget) {
        const payloadSnapshot = readClientSnapshotStateSyncPayload(message);
        return resolvePrincipalRecipients(
            webSocketServer,
            {
                principalRef: principalTarget,
                payloadSnapshots: payloadSnapshot ? [payloadSnapshot] : [],
            },
            options,
        );
    }
    const payload = parseStateSyncPayload(message);
    if (!payload) {
        return undefined;
    }

    switch (payload.kind) {
        case 'invalid':
            return [];
        case 'client':
            return resolveScopeRecipients(
                webSocketServer,
                payload.scope,
                options,
                payload.snapshot ? [payload.snapshot] : [],
            );
        case 'group':
            return resolveGroupRecipients(webSocketServer, payload.snapshot, options);
        case 'group-directory':
            return resolveGroupRecipients(webSocketServer, payload.snapshot, options);
        case 'group-event': {
            if (payload.audienceSessionIds !== undefined) {
                return toOpenConnectionRecipients(webSocketServer, payload.audienceSessionIds);
            }
            const groupRef = {
                ...payload.scope,
                groupId: payload.groupId,
            };
            const configuredSnapshot = options.findGroupSnapshotByRef?.(groupRef) ??
                options.findGroupSnapshotById?.(payload.groupId);
            const snapshot = configuredSnapshot && sameScope(configuredSnapshot.group, payload.scope)
                ? configuredSnapshot
                : groupStateSnapshotsRepository.findGroupStateSnapshotByRef(groupRef);
            return snapshot
                ? resolveGroupRecipients(webSocketServer, snapshot, options)
                : [];
        }
    }
}

export function toStateSyncConnectionFilter(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {},
): ((ctx: ConnectionContext) => boolean) | undefined {
    const recipients = resolveStateSyncRecipients(webSocketServer, message, options);
    if (!recipients) {
        return undefined;
    }

    const connectionIds = new Set(recipients.map((recipient) => recipient.connectionId));
    return (ctx) => connectionIds.has(ctx.id);
}

export function sendStateSyncMessage(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {},
): number {
    const recipients = resolveStateSyncRecipients(webSocketServer, message, options);
    if (!recipients) {
        return webSocketServer.broadcast(message);
    }

    if (recipients.length === 0) {
        return 0;
    }

    const encoded = webSocketServer.encode(message);
    let sent = 0;
    for (const recipient of recipients) {
        try {
            webSocketServer.sendEncoded(recipient.connectionId, encoded);
            sent += 1;
        } catch (error) {
            console.error('State sync send failed:', error);
        }
    }

    return sent;
}

interface PrincipalRecipientTarget {
    readonly principalRef: ClientPrincipalRef;
    /**
     * Authoritative client snapshots carried by the row itself. The mutation
     * that produced the row may have committed on another server, so the
     * local cache does not yet list the very session the snapshot announces.
     */
    readonly payloadSnapshots: readonly ClientSnapshot[];
}

/**
 * Scope 'principal' resolves at delivery time to the principal's own live
 * sessions plus live sessions of groups the principal is an active member of.
 * It never falls through to every open connection, unlike the legacy
 * world-broadcast rows whose payload sniffing this branch bypasses.
 */
function resolvePrincipalRecipients(
    webSocketServer: JsonWebSocketServer,
    target: PrincipalRecipientTarget,
    options: StateSyncRoutingOptions,
): readonly WsServerResolvedRecipient[] {
    const principalRef = target.principalRef;
    const clientSnapshots = [
        ...(options.readClientSnapshots?.() ??
            clientStateSnapshotsRepository.getAllClientStateSnapshots()),
        ...target.payloadSnapshots,
    ];
    const ownRecipients = clientSnapshots
        .filter((snapshot) =>
            sameScope(snapshot.principal, principalRef) &&
            snapshot.principal.principalId === principalRef.principalId
        )
        .flatMap((snapshot) =>
            toOpenClientSessionRecipients(webSocketServer, snapshot, options)
        );
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

function resolveScopeRecipients(
    webSocketServer: JsonWebSocketServer,
    scope: StateSyncScope,
    options: StateSyncRoutingOptions,
    extraSnapshots: readonly ClientSnapshot[] = [],
): readonly WsServerResolvedRecipient[] {
    const snapshots = [
        ...(options.readClientSnapshots?.() ??
            clientStateSnapshotsRepository.getAllClientStateSnapshots()),
        ...extraSnapshots,
    ];

    return dedupRecipients(
        snapshots
            .filter((snapshot) => sameScope(snapshot.principal, scope))
            .flatMap((snapshot) =>
                toOpenClientSessionRecipients(webSocketServer, snapshot, options)
            ),
    );
}

function resolveGroupRecipients(
    webSocketServer: JsonWebSocketServer,
    snapshot: GroupSnapshot,
    options: StateSyncRoutingOptions,
): readonly WsServerResolvedRecipient[] {
    const now = options.now?.() ?? Date.now();
    const clientSnapshots = options.readClientSnapshots?.() ??
        clientStateSnapshotsRepository.getAllClientStateSnapshots();
    const fullReadPrincipalIds = new Set(
        snapshot.members
            .filter((member) =>
                readGroupVisibility({
                    snapshot,
                    actor: { principalId: member.principalId },
                    nowEpochMs: now,
                }) === 'full'
            )
            .map((member) => member.principalId),
    );
    const scopedFullReadSessionIds = new Set<string>();
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

            scopedFullReadSessionIds.add(session.sessionId);
            if (webSocketServer.connections.get(session.sessionId)?.isOpen) {
                clientRecipients.push({
                    peerId: clientSnapshot.principal.principalId,
                    connectionId: session.sessionId,
                });
            }
        }
    }
    const presenceRecipients = snapshot.activeSessions
        .filter((session) =>
            fullReadPrincipalIds.has(session.principalId) &&
            scopedFullReadSessionIds.has(session.sessionId) &&
            isGroupSnapshotSessionLive(session, now) &&
            webSocketServer.connections.get(session.sessionId)?.isOpen
        )
        .map((session) => ({
            peerId: session.principalId,
            connectionId: session.sessionId,
        }));

    return dedupRecipients([...clientRecipients, ...presenceRecipients]);
}

/**
 * Delta-envelope rows persist their computed audience at write time; delivery
 * intersects it with locally open connections only. Sessions without a local
 * open connection are dropped silently — late joiners converge through their
 * join-time snapshot pull, never through event fanout.
 */
function toOpenConnectionRecipients(
    webSocketServer: JsonWebSocketServer,
    audienceSessionIds: readonly string[],
): readonly WsServerResolvedRecipient[] {
    return dedupRecipients(
        audienceSessionIds
            .filter((sessionId) => webSocketServer.connections.get(sessionId)?.isOpen)
            .map((sessionId) => ({
                peerId: sessionId,
                connectionId: sessionId,
            })),
    );
}

function toOpenClientSessionRecipients(
    webSocketServer: JsonWebSocketServer,
    snapshot: ClientSnapshot,
    options: StateSyncRoutingOptions = {},
): readonly WsServerResolvedRecipient[] {
    const now = options.now?.() ?? Date.now();
    return snapshot.activeSessions
        .filter((session) =>
            isClientSnapshotSessionLive(session, now) &&
            webSocketServer.connections.get(session.sessionId)?.isOpen
        )
        .map((session) => ({
            peerId: snapshot.principal.principalId,
            connectionId: session.sessionId,
        }));
}

function dedupRecipients(
    recipients: readonly WsServerResolvedRecipient[],
): readonly WsServerResolvedRecipient[] {
    const byConnectionId = new Map<string, WsServerResolvedRecipient>();
    for (const recipient of recipients) {
        byConnectionId.set(recipient.connectionId, recipient);
    }
    return [...byConnectionId.values()];
}

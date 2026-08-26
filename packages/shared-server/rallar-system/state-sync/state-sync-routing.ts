import { readGroupVisibility } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import {
    isClientSnapshotSessionLive,
    isGroupSnapshotSessionLive,
    type RallarSnapshotPresenceClock
} from '../presence/snapshot-presence.ts';
import {
    decodeStateSyncMessage,
    sameScope,
    type StateSyncDecodeResult,
    type StateSyncPayload
} from './state-sync-payload.ts';

export interface StateSyncRoutingOptions {
    readonly findGroupSnapshotByRef?: (ref: GroupRef) => GroupSnapshot | undefined;
    readonly findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    readonly readClientSnapshots?: () => readonly ClientSnapshot[];
    readonly readGroupSnapshots?: () => readonly GroupSnapshot[];
    readonly now?: RallarSnapshotPresenceClock;
}

export function resolveStateSyncRecipients(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {}
): readonly WsServerResolvedRecipient[] | undefined {
    return resolveDecodedStateSyncRecipients(
        webSocketServer,
        decodeStateSyncMessage(message),
        options
    );
}

export function resolveDecodedStateSyncRecipients(
    webSocketServer: JsonWebSocketServer,
    decoded: StateSyncDecodeResult,
    options: StateSyncRoutingOptions = {}
): readonly WsServerResolvedRecipient[] | undefined {
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
        case 'client-snapshot':
            return resolvePrincipalRecipients(
                webSocketServer,
                {
                    principalRef: payload.snapshot.principal,
                    payloadSnapshots: [payload.snapshot]
                },
                options
            );
        case 'client-event':
            return resolvePrincipalRecipients(
                webSocketServer,
                {
                    principalRef: payload.event,
                    payloadSnapshots: []
                },
                options
            );
        case 'group-snapshot':
            return resolveGroupRecipients(webSocketServer, payload.snapshot, options);
        case 'group-directory-snapshot':
            return resolveGroupRecipients(webSocketServer, payload.snapshot, options);
        case 'group-event':
            return toOpenConnectionRecipients(
                webSocketServer,
                payload.envelope.audienceSessionIds
            );
    }
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
 * It never falls through to every open connection.
 */
function resolvePrincipalRecipients(
    webSocketServer: JsonWebSocketServer,
    target: PrincipalRecipientTarget,
    options: StateSyncRoutingOptions
): readonly WsServerResolvedRecipient[] {
    const principalRef = target.principalRef;
    const clientSnapshots = [
        ...(options.readClientSnapshots?.() ??
            clientStateSnapshotsRepository.getAllClientStateSnapshots()),
        ...target.payloadSnapshots
    ];
    const ownRecipients = clientSnapshots
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
    const clientSnapshots = options.readClientSnapshots?.() ??
        clientStateSnapshotsRepository.getAllClientStateSnapshots();
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
                    connectionId: session.sessionId
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
            connectionId: session.sessionId
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

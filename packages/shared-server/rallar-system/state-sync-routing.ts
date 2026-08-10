import {
    type ALMessage,
    readALPrincipalBroadcastTarget,
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type {
    ClientEvent,
    ClientPrincipalRef,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
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

type StateSyncScope = Readonly<{
    applicationId: string;
    workspaceId: string;
}>;

export type StateSyncRoutingOptions = Readonly<{
    findGroupSnapshotByRef?: (ref: GroupRef) => GroupSnapshot | undefined;
    findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    readClientSnapshots?: () => readonly ClientSnapshot[];
    readGroupSnapshots?: () => readonly GroupSnapshot[];
    now?: RallarSnapshotPresenceClock;
}>;

/**
 * The authoritative group snapshot carried by a state-sync row, when the row
 * is a group or group-directory snapshot for that exact group. Delivery-time
 * audience resolution may use it when a process-local cache lags the row.
 */
export function readGroupSnapshotStateSyncPayload(
    message: ALMessage,
): GroupSnapshot | undefined {
    const payload = parseStateSyncPayload(message);
    return payload && (payload.kind === 'group' || payload.kind === 'group-directory')
        ? payload.snapshot
        : undefined;
}

export function resolveStateSyncRecipients(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {},
): readonly WsServerResolvedRecipient[] | undefined {
    const principalTarget = readALPrincipalBroadcastTarget(message);
    if (principalTarget) {
        return resolvePrincipalRecipients(webSocketServer, principalTarget, options);
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

/**
 * Scope 'principal' resolves at delivery time to the principal's own live
 * sessions plus live sessions of groups the principal is an active member of.
 * It never falls through to every open connection, unlike the legacy
 * world-broadcast rows whose payload sniffing this branch bypasses.
 */
function resolvePrincipalRecipients(
    webSocketServer: JsonWebSocketServer,
    principalRef: ClientPrincipalRef,
    options: StateSyncRoutingOptions,
): readonly WsServerResolvedRecipient[] {
    const clientSnapshots = options.readClientSnapshots?.() ??
        clientStateSnapshotsRepository.getAllClientStateSnapshots();
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

function parseStateSyncPayload(message: ALMessage):
    | Readonly<{
    kind: 'client';
    scope: StateSyncScope;
    snapshot?: ClientSnapshot;
}>
    | Readonly<{
    kind: 'group';
    snapshot: GroupSnapshot;
}>
    | Readonly<{
    kind: 'group-directory';
    snapshot: GroupSnapshot;
}>
    | Readonly<{
    kind: 'group-event';
    scope: StateSyncScope;
    groupId: string;
}>
    | Readonly<{
    kind: 'invalid';
}>
    | undefined {
    try {
        switch (message.payload.typeId) {
            case AppTopics.clientStateSnapshot: {
                const snapshot = JSON.parse(message.payload.resource);
                if (!isClientSnapshot(snapshot)) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'client',
                    scope: snapshot.principal,
                    snapshot,
                };
            }
            case AppTopics.clientStateEvent: {
                const event = JSON.parse(message.payload.resource);
                if (!isClientEvent(event)) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'client',
                    scope: event,
                };
            }
            case AppTopics.groupStateSnapshot: {
                const snapshot = JSON.parse(message.payload.resource);
                if (
                    !isGroupSnapshot(snapshot) ||
                    !hasMatchingExplicitGroupAudience(message, snapshot.group)
                ) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'group',
                    snapshot,
                };
            }
            case AppTopics.groupDirectorySnapshot: {
                const snapshot = JSON.parse(message.payload.resource);
                if (
                    !isGroupSnapshot(snapshot) ||
                    !hasMatchingExplicitGroupAudience(message, snapshot.group)
                ) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'group-directory',
                    snapshot,
                };
            }
            case AppTopics.groupStateEvent: {
                const event = JSON.parse(message.payload.resource);
                if (
                    !isGroupEvent(event) ||
                    !hasMatchingExplicitGroupAudience(message, event)
                ) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'group-event',
                    scope: event,
                    groupId: event.groupId,
                };
            }
            case AppTopics.overlayTopology: {
                const snapshot = JSON.parse(message.payload.resource);
                if (
                    !isOverlayTopologySnapshot(snapshot) ||
                    !hasMatchingExplicitGroupAudience(message, snapshot.groupRef)
                ) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'group-event',
                    scope: snapshot.groupRef,
                    groupId: snapshot.groupRef.groupId,
                };
            }
            default:
                return undefined;
        }
    } catch {
        return isStateSyncTopic(message.payload.typeId)
            ? { kind: 'invalid' }
            : undefined;
    }
}

function hasMatchingExplicitGroupAudience(
    message: ALMessage,
    groupRef: GroupRef,
): boolean {
    const targets = message.targets;
    const targetRef = targets?.mode === 'multicast'
        ? targets.groupRef
        : targets?.mode === 'broadcast' && targets.groupRef !== undefined
        ? targets.groupRef
        : undefined;
    return targetRef === undefined ||
        (
            targetRef.applicationId === groupRef.applicationId &&
            targetRef.workspaceId === groupRef.workspaceId &&
            targetRef.groupId === groupRef.groupId
        );
}

function sameScope(
    left: StateSyncScope,
    right: StateSyncScope,
): boolean {
    return left.applicationId === right.applicationId &&
        (left.workspaceId ?? '') === (right.workspaceId ?? '');
}

function isStateSyncTopic(typeId: string): boolean {
    return typeId === AppTopics.clientStateSnapshot ||
        typeId === AppTopics.clientStateEvent ||
        typeId === AppTopics.groupStateSnapshot ||
        typeId === AppTopics.groupDirectorySnapshot ||
        typeId === AppTopics.groupStateEvent ||
        typeId === AppTopics.overlayTopology;
}

function isOverlayTopologySnapshot(
    value: unknown,
): value is RallarOverlayTopologySnapshot {
    if (!isRecord(value) || !isRecord(value.groupRef)) {
        return false;
    }

    const groupRef = value.groupRef;
    return typeof groupRef.groupId === 'string' &&
        hasStateSyncScope(groupRef) &&
        typeof value.overlayId === 'string' &&
        typeof value.topology === 'string' &&
        isRecord(value.nextHopsBySessionId);
}

function isClientSnapshot(value: unknown): value is ClientSnapshot {
    return isRecord(value) &&
        isRecord(value.principal) &&
        typeof value.principal.principalId === 'string' &&
        hasStateSyncScope(value.principal) &&
        Array.isArray(value.activeSessions);
}

function isClientEvent(value: unknown): value is ClientEvent {
    return isRecord(value) &&
        typeof value.principalId === 'string' &&
        typeof value.snapshotVersion === 'number' &&
        hasStateSyncScope(value);
}

function isGroupSnapshot(value: unknown): value is GroupSnapshot {
    return isRecord(value) &&
        isRecord(value.group) &&
        typeof value.group.groupId === 'string' &&
        hasStateSyncScope(value.group) &&
        Array.isArray(value.members) &&
        Array.isArray(value.activeSessions);
}

function isGroupEvent(value: unknown): value is GroupEvent {
    return isRecord(value) &&
        typeof value.groupId === 'string' &&
        typeof value.snapshotVersion === 'number' &&
        hasStateSyncScope(value);
}

function hasStateSyncScope(value: Record<string, unknown>): value is StateSyncScope {
    return typeof value.applicationId === 'string' &&
        (value.workspaceId === undefined || typeof value.workspaceId === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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

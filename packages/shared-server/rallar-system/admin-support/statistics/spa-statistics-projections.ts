import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    SpaStatisticsSafeGroupSummary,
    SpaStatisticsWarning
} from '@shared/api/spa-statistics-types.ts';
import type { RallarServerWsStatus } from '../../websocket/router/rallar-server-ws-status.ts';

export interface SpaStatisticsActor {
    readonly principalId: string;
    readonly sessionId: string;
}

export function toSpaStatisticsActor(authSession: AuthSession): SpaStatisticsActor {
    return {
        principalId: authSession.clientId,
        sessionId: authSession.sessionId
    };
}

export function toSafeGroupSummary(snapshot: GroupSnapshot): SpaStatisticsSafeGroupSummary {
    return {
        groupRef: {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        },
        displayName: snapshot.group.displayName,
        kind: snapshot.group.kind,
        status: snapshot.group.status,
        joinMode: snapshot.group.joinMode,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        activeSessionCount: snapshot.activeSessions.length,
        snapshotVersion: snapshot.group.snapshotVersion,
        presenceVersion: snapshot.group.presenceVersion
    };
}

export function countActiveClientSessions(snapshot: ClientSnapshot | undefined): number {
    return snapshot?.activeSessionCount ?? snapshot?.activeSessions.length ?? 0;
}

export function countActorGroupPresenceSessions(
    snapshots: readonly GroupSnapshot[],
    principalId: string
): number {
    return snapshots.reduce(
        (total, snapshot) =>
            total +
            snapshot.activeSessions.filter((session) => session.principalId === principalId).length,
        0
    );
}

export function hasActiveMember(snapshot: GroupSnapshot, principalId: string): boolean {
    return snapshot.members.some(
        (member) => member.principalId === principalId && member.status === 'active'
    );
}

export function toOwnerDetails(
    snapshot: GroupSnapshot
): GroupSpaStatisticsResponse['owner'] | undefined {
    if (snapshot.group.maxMembers === null && snapshot.group.maxSessionsPerMember === null) {
        return undefined;
    }

    return {
        maxMembers: snapshot.group.maxMembers ?? undefined,
        maxSessionsPerMember: snapshot.group.maxSessionsPerMember ?? undefined
    };
}

export function isSessionOpen(
    status: RallarServerWsStatus | undefined,
    sessionId: string | undefined
): boolean {
    if (!status || !sessionId) {
        return false;
    }
    if (status.openConnectionIds.includes(sessionId)) {
        return true;
    }
    return status.connections.some(
        (connection) => connection.connectionId === sessionId && connection.isOpen
    );
}

export function spaStatisticsWarning(
    code: SpaStatisticsWarning['code'],
    message: string
): SpaStatisticsWarning {
    return { code, message };
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    const normalized = Math.floor(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

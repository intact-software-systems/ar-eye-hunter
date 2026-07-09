import type {
    GroupJoinMode,
    GroupRef,
    GroupRole,
    GroupStatus,
} from './group-types.ts';
import type { StateScope } from './state-types.ts';

export const SPA_STATISTICS_WARNING_CODES = [
    'policy-filtered-scan',
    'bounded-snapshot-scan',
    'bounded-recent-events',
    'process-local-realtime',
    'websocket-session-missing',
    'client-session-missing',
    'group-presence-filtered',
] as const;

export type SpaStatisticsWarningCode =
    typeof SPA_STATISTICS_WARNING_CODES[number];

export type SpaStatisticsWarning = Readonly<{
    code: SpaStatisticsWarningCode;
    message: string;
    source?: string;
}>;

export type SpaStatisticsActor = Readonly<{
    principalId: string;
    sessionId?: string;
}>;

export type SpaStatisticsBoundedCount = Readonly<{
    count: number;
    limit: number;
    bounded: true;
}>;

export type SpaStatisticsSafeGroupSummary = Readonly<{
    groupRef: GroupRef;
    displayName: string;
    kind: 'party' | 'room' | 'team' | 'custom';
    status: GroupStatus;
    joinMode: GroupJoinMode;
    memberCount: number;
    onlineMemberCount: number;
    activeSessionCount: number;
    snapshotVersion: number;
    presenceVersion: number;
}>;

export type WorkspaceSpaStatisticsResponse = Readonly<{
    generatedAtEpochMs: number;
    scope: StateScope;
    actor: SpaStatisticsActor & Readonly<{
        activeClientSessionCount: number;
        groupPresenceCount: number;
    }>;
    warnings: readonly SpaStatisticsWarning[];
    groups: Readonly<{
        fullReadableCount: number;
        joinedCount: number;
        onlineMemberCount: number;
    }>;
    activity: Readonly<{
        recentVisibleGroupEventCount: SpaStatisticsBoundedCount;
    }>;
    topGroups: readonly SpaStatisticsSafeGroupSummary[];
}>;

export type GroupSpaStatisticsResponse = Readonly<{
    generatedAtEpochMs: number;
    scope: StateScope;
    groupRef: GroupRef;
    actor: SpaStatisticsActor & Readonly<{
        role?: GroupRole;
        activePresenceSessionCount: number;
    }>;
    warnings: readonly SpaStatisticsWarning[];
    group: Omit<SpaStatisticsSafeGroupSummary, 'groupRef'> & Readonly<{
        groupId: string;
    }>;
    activity: Readonly<{
        recentGroupEventCount: SpaStatisticsBoundedCount;
    }>;
    owner?: Readonly<{
        maxMembers?: number;
        maxSessionsPerMember?: number;
    }>;
}>;

export type MyRealtimeSpaStatisticsResponse = Readonly<{
    generatedAtEpochMs: number;
    scope: StateScope;
    actor: SpaStatisticsActor;
    warnings: readonly SpaStatisticsWarning[];
    realtime: Readonly<{
        processLocal: true;
        currentSessionOpen: boolean;
    }>;
    clientState: Readonly<{
        activeClientSessionCount: number;
        currentSessionInClientState: boolean;
    }>;
    groupPresence: Readonly<{
        activeGroupPresenceCount: number;
        groups: readonly (Omit<SpaStatisticsSafeGroupSummary, 'activeSessionCount' | 'memberCount' | 'onlineMemberCount' | 'snapshotVersion' | 'presenceVersion'> & Readonly<{
            actorSessionPresent: true;
        }>)[];
    }>;
}>;

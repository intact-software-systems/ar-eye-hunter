import type {
    GroupMemberStatus,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    PrincipalId,
    SessionId,
} from '../api/group-types.ts';

export type RallarMatchParticipant = Readonly<{
    participantId: string;
    principalId?: PrincipalId;
    role?: GroupRole;
    status?: GroupMemberStatus;
    online: boolean;
    sessionIds: readonly SessionId[];
    displayName?: string;
}>;

export type RallarMatchParticipantIdentity = Readonly<{
    principalId: PrincipalId;
    role?: GroupRole;
    status?: GroupMemberStatus;
    sessionIds: readonly SessionId[];
}>;

export type RallarMatchParticipantResolver = (
    identity: RallarMatchParticipantIdentity,
) => string;

export type RallarMatchParticipantsInput = Readonly<{
    snapshot?: Pick<GroupSnapshot, 'members' | 'activeSessions'>;
    members?: readonly RallarMatchParticipant[];
    includeInactiveMembers?: boolean;
    resolveParticipantId?: RallarMatchParticipantResolver;
}>;

export type RallarMatchMetricMap = Readonly<Record<string, number>>;

export type RallarMatchStandingRow = Readonly<{
    participantId: string;
    principalId?: PrincipalId;
    sessionIds: readonly SessionId[];
    metrics: RallarMatchMetricMap;
}>;

export type RallarMatchStanding = RallarMatchStandingRow & Readonly<{
    rank: number;
    tieGroup: number;
}>;

export type RallarMatchStandingComparator = (
    left: RallarMatchStandingRow,
    right: RallarMatchStandingRow,
) => number;

export type RallarMatchStandingsInput = Readonly<{
    rows: readonly RallarMatchStandingRow[];
    compare?: RallarMatchStandingComparator;
}>;

export type RallarMatchAuthorityKind = 'browser-director' | 'server';

type RallarMatchAuthorityDescriptorBase = Readonly<{
    id: string;
    epoch: number;
}>;

export type RallarMatchBrowserDirectorAuthorityDescriptor =
    RallarMatchAuthorityDescriptorBase &
    Readonly<{
        kind: 'browser-director';
        principalId: PrincipalId;
        sessionId: SessionId;
    }>;

export type RallarMatchServerAuthorityDescriptor =
    RallarMatchAuthorityDescriptorBase &
    Readonly<{
        kind: 'server';
        principalId?: never;
        sessionId?: never;
    }>;

export type RallarMatchAuthorityDescriptor =
    | RallarMatchBrowserDirectorAuthorityDescriptor
    | RallarMatchServerAuthorityDescriptor;

export type RallarMatchTrust = 'local' | 'room-trusted' | 'server-validated';

type RallarMatchResultFields<TSummary> = Readonly<{
    resultId: string;
    matchId: string;
    roomRef: GroupRef;
    protocol: string;
    startedAtEpochMs?: number;
    finishedAtEpochMs: number;
    standings: readonly RallarMatchStanding[];
    summary: TSummary;
    idempotencyKey: string;
}>;

export type RallarLocalMatchResult<TSummary = unknown> =
    RallarMatchResultFields<TSummary> &
    Readonly<{
        authority: RallarMatchAuthorityDescriptor;
        trust: 'local';
    }>;

export type RallarRoomTrustedMatchResult<TSummary = unknown> =
    RallarMatchResultFields<TSummary> &
    Readonly<{
        authority: RallarMatchBrowserDirectorAuthorityDescriptor;
        trust: 'room-trusted';
    }>;

export type RallarServerValidatedMatchResult<TSummary = unknown> =
    RallarMatchResultFields<TSummary> &
    Readonly<{
        authority: RallarMatchServerAuthorityDescriptor;
        trust: 'server-validated';
    }>;

export type RallarMatchResult<TSummary = unknown> =
    | RallarLocalMatchResult<TSummary>
    | RallarRoomTrustedMatchResult<TSummary>
    | RallarServerValidatedMatchResult<TSummary>;

export type RallarLocalMatchResultInput<TSummary = unknown> =
    Omit<RallarLocalMatchResult<TSummary>, 'idempotencyKey'> &
    Readonly<{ idempotencyKey?: string }>;

export type RallarRoomTrustedMatchResultInput<TSummary = unknown> =
    Omit<RallarRoomTrustedMatchResult<TSummary>, 'idempotencyKey'> &
    Readonly<{ idempotencyKey?: string }>;

export type RallarMatchResultInput<TSummary = unknown> =
    | RallarLocalMatchResultInput<TSummary>
    | RallarRoomTrustedMatchResultInput<TSummary>;

export type RallarMatchDiagnosticsInput<TSummary = unknown> = Readonly<{
    participants?: readonly RallarMatchParticipant[];
    standings?: readonly RallarMatchStanding[];
    result?: RallarMatchResult<TSummary>;
    authorityFresh?: boolean;
    pendingCommandCount?: number;
    snapshotAgeMs?: number;
    maxSnapshotAgeMs?: number;
}>;

export type RallarMatchDiagnostics = Readonly<{
    participantCount: number;
    standingCount: number;
    hasResult: boolean;
    pendingCommandCount: number;
    snapshotAgeMs?: number;
    issues: readonly string[];
}>;

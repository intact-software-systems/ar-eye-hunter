import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    SpaStatisticsSafeGroupSummary,
    SpaStatisticsWarning,
    WorkspaceSpaStatisticsResponse,
} from '@shared/api/spa-statistics-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { RallarServerWsStatus } from '../../rallar-facade/ws-topic-router.ts';
import {
    canReadGroupSnapshot,
    canUpdateGroupSnapshot,
    GroupPolicyDeniedError,
} from '../group-policy.ts';
import type { ClientStateService } from '../client-state/client-state-service-contracts.ts';
import type { GroupStateService } from '../services/group-state-service.ts';
import {
    listRecentStateEvents,
    type StateEventListQuery,
} from '../state-event-listing.ts';

const DEFAULT_RECENT_EVENT_LIMIT = 20;
const DEFAULT_TOP_GROUPS_LIMIT = 10;
const DEFAULT_SNAPSHOT_SCAN_LIMIT = 100;

export type SpaStatisticsServiceOptions = Readonly<{
    clientStateService: Pick<ClientStateService, 'readSnapshot' | 'readPresenceSnapshot'>;
    groupStateService: Pick<
        GroupStateService,
        | 'listSnapshots'
        | 'listSnapshotsPage'
        | 'readSnapshot'
        | 'listEvents'
        | 'listRecentEvents'
    >;
    wsStatus?: () => RallarServerWsStatus | undefined;
    now?: () => number;
    recentEventLimit?: number;
    topGroupsLimit?: number;
    snapshotScanLimit?: number;
}>;

export type ReadWorkspaceSpaStatisticsInput = Readonly<{
    scope: StateScope;
    authSession: AuthSession;
}>;

export type ReadGroupSpaStatisticsInput =
    & ReadWorkspaceSpaStatisticsInput
    & Readonly<{
        groupId: string;
    }>;

export class SpaStatisticsService {
    private readonly now: () => number;
    private readonly recentEventLimit: number;
    private readonly topGroupsLimit: number;
    private readonly snapshotScanLimit: number;

    private readonly options: SpaStatisticsServiceOptions;

    public constructor(options: SpaStatisticsServiceOptions) {
        this.options = options;
        this.now = options.now ?? (() => Date.now());
        this.recentEventLimit = options.recentEventLimit ??
            DEFAULT_RECENT_EVENT_LIMIT;
        this.topGroupsLimit = options.topGroupsLimit ??
            DEFAULT_TOP_GROUPS_LIMIT;
        this.snapshotScanLimit = normalizePositiveInteger(
            options.snapshotScanLimit,
            DEFAULT_SNAPSHOT_SCAN_LIMIT,
        );
    }

    public async readWorkspaceSummary(
        input: ReadWorkspaceSpaStatisticsInput,
    ): Promise<WorkspaceSpaStatisticsResponse> {
        const actor = toActor(input.authSession);
        const clientSnapshot = await this.options.clientStateService.readSnapshot({
            ...input.scope,
            principalId: actor.principalId,
        });
        const groupScan = await readBoundedGroupSnapshots(
            this.options.groupStateService,
            input.scope,
            this.snapshotScanLimit,
        );
        const readableGroups = groupScan.snapshots.filter((snapshot) =>
            canReadGroupSnapshot({
                snapshot,
                actor: {
                    principalId: actor.principalId,
                    sessionId: actor.sessionId,
                },
            }).allowed
        );
        const recentEventCount = await countRecentGroupEvents(
            this.options.groupStateService,
            readableGroups.map((snapshot) => snapshot.group),
            this.recentEventLimit,
        );

        return {
            generatedAtEpochMs: this.now(),
            scope: input.scope,
            actor: {
                ...actor,
                activeClientSessionCount: countActiveClientSessions(clientSnapshot),
                groupPresenceCount: countActorGroupPresenceSessions(
                    readableGroups,
                    actor.principalId,
                ),
            },
            warnings: [
                warning(
                    'policy-filtered-scan',
                    'Workspace statistics count only groups the actor can read fully.',
                ),
                warning(
                    'bounded-snapshot-scan',
                    `Workspace statistics are derived from at most ${this.snapshotScanLimit} group snapshots.`,
                ),
                warning(
                    'bounded-recent-events',
                    'Activity counts are bounded recent event counts, not global exact totals.',
                ),
            ],
            groups: {
                fullReadableCount: readableGroups.length,
                joinedCount:
                    readableGroups.filter((snapshot) => hasActiveMember(snapshot, actor.principalId)).length,
                onlineMemberCount: readableGroups.reduce(
                    (total, snapshot) => total + snapshot.onlineMemberCount,
                    0,
                ),
            },
            activity: {
                recentVisibleGroupEventCount: {
                    count: recentEventCount,
                    limit: this.recentEventLimit,
                    bounded: true,
                },
            },
            topGroups: readableGroups
                .map(toSafeGroupSummary)
                .sort((left, right) =>
                    right.onlineMemberCount - left.onlineMemberCount ||
                    right.activeSessionCount - left.activeSessionCount ||
                    left.displayName.localeCompare(right.displayName)
                )
                .slice(0, this.topGroupsLimit),
        };
    }

    public async readGroupStats(
        input: ReadGroupSpaStatisticsInput,
    ): Promise<GroupSpaStatisticsResponse> {
        const actor = toActor(input.authSession);
        const groupRef = {
            ...input.scope,
            groupId: input.groupId,
        };
        const snapshot = await this.options.groupStateService.readSnapshot(groupRef);
        if (!snapshot) {
            throw new Error(`Group not found: ${input.groupId}`);
        }

        const readPolicy = canReadGroupSnapshot({
            snapshot,
            actor: {
                principalId: actor.principalId,
                sessionId: actor.sessionId,
            },
        });
        if (!readPolicy.allowed) {
            throw new GroupPolicyDeniedError(readPolicy);
        }

        const recentEvents = await listRecentGroupEvents(
            this.options.groupStateService,
            groupRef,
            { limit: this.recentEventLimit },
        );
        const safeGroup = toSafeGroupSummary(snapshot);
        const activeMember = snapshot.members.find((member) =>
            member.principalId === actor.principalId && member.status === 'active'
        );
        const owner = canUpdateGroupSnapshot({
                snapshot,
                actor: {
                    principalId: actor.principalId,
                    sessionId: actor.sessionId,
                },
            }).allowed
            ? toOwnerDetails(snapshot)
            : undefined;

        return {
            generatedAtEpochMs: this.now(),
            scope: input.scope,
            groupRef,
            actor: {
                ...actor,
                role: activeMember?.role,
                activePresenceSessionCount: countActorGroupPresenceSessions(
                    [snapshot],
                    actor.principalId,
                ),
            },
            warnings: [
                warning(
                    'bounded-recent-events',
                    'Activity counts are bounded recent event counts, not global exact totals.',
                ),
            ],
            group: {
                groupId: safeGroup.groupRef.groupId,
                displayName: safeGroup.displayName,
                kind: safeGroup.kind,
                status: safeGroup.status,
                joinMode: safeGroup.joinMode,
                memberCount: safeGroup.memberCount,
                onlineMemberCount: safeGroup.onlineMemberCount,
                activeSessionCount: safeGroup.activeSessionCount,
                snapshotVersion: safeGroup.snapshotVersion,
                presenceVersion: safeGroup.presenceVersion,
            },
            activity: {
                recentGroupEventCount: {
                    count: recentEvents.length,
                    limit: this.recentEventLimit,
                    bounded: true,
                },
            },
            ...(owner ? { owner } : {}),
        };
    }

    public async readMyRealtimeStatus(
        input: ReadWorkspaceSpaStatisticsInput,
    ): Promise<MyRealtimeSpaStatisticsResponse> {
        const actor = toActor(input.authSession);
        const clientSnapshot = await this.options.clientStateService.readSnapshot({
            ...input.scope,
            principalId: actor.principalId,
        });
        const groupScan = await readBoundedGroupSnapshots(
            this.options.groupStateService,
            input.scope,
            this.snapshotScanLimit,
        );
        const readableGroups = groupScan.snapshots.filter((snapshot) =>
            canReadGroupSnapshot({
                snapshot,
                actor: {
                    principalId: actor.principalId,
                    sessionId: actor.sessionId,
                },
            }).allowed
        );
        const groupsWithCurrentSession = readableGroups.filter((snapshot) =>
            snapshot.activeSessions.some((session) =>
                session.principalId === actor.principalId &&
                session.sessionId === actor.sessionId
            )
        );
        const currentSessionOpen = isSessionOpen(
            this.options.wsStatus?.(),
            actor.sessionId,
        );
        const currentSessionInClientState = Boolean(
            clientSnapshot?.activeSessions.some((session) => session.sessionId === actor.sessionId),
        );
        const warnings: SpaStatisticsWarning[] = [
            warning(
                'process-local-realtime',
                'WebSocket readiness is checked against this API process only.',
            ),
        ];
        if (!currentSessionOpen) {
            warnings.push(warning(
                'websocket-session-missing',
                'The current auth session does not have an open WebSocket on this server.',
            ));
        }
        if (!currentSessionInClientState) {
            warnings.push(warning(
                'client-session-missing',
                'The current auth session is not present in client state.',
            ));
        }
        if (groupScan.hasMore) {
            warnings.push(warning(
                'bounded-snapshot-scan',
                `Realtime group presence is derived from at most ${this.snapshotScanLimit} group snapshots.`,
            ));
        }
        if (groupsWithCurrentSession.length !== groupScan.snapshots.length) {
            warnings.push(warning(
                'group-presence-filtered',
                'Group presence lists only readable groups containing the current auth session.',
            ));
        }

        return {
            generatedAtEpochMs: this.now(),
            scope: input.scope,
            actor,
            warnings,
            realtime: {
                processLocal: true,
                currentSessionOpen,
            },
            clientState: {
                activeClientSessionCount: countActiveClientSessions(clientSnapshot),
                currentSessionInClientState,
            },
            groupPresence: {
                activeGroupPresenceCount: groupsWithCurrentSession.length,
                groups: groupsWithCurrentSession.map((snapshot) => {
                    const safe = toSafeGroupSummary(snapshot);
                    return {
                        groupRef: safe.groupRef,
                        displayName: safe.displayName,
                        kind: safe.kind,
                        status: safe.status,
                        joinMode: safe.joinMode,
                        actorSessionPresent: true,
                    };
                }),
            },
        };
    }
}

async function countRecentGroupEvents(
    service: SpaStatisticsServiceOptions['groupStateService'],
    refs: readonly GroupRef[],
    limit: number,
): Promise<number> {
    const totalLimit = Math.max(0, Math.floor(limit));
    let count = 0;

    for (const ref of refs) {
        const remaining = totalLimit - count;
        if (remaining <= 0) {
            break;
        }

        const events = await listRecentGroupEvents(service, ref, {
            limit: remaining,
        });
        count += Math.min(events.length, remaining);
    }

    return count;
}

async function readBoundedGroupSnapshots(
    service: SpaStatisticsServiceOptions['groupStateService'],
    scope: StateScope,
    limit: number,
): Promise<
    Readonly<{
        snapshots: readonly GroupSnapshot[];
        scannedGroupCount: number;
        hasMore: boolean;
    }>
> {
    const scanLimit = Math.max(1, Math.floor(limit));

    if (service.listSnapshotsPage) {
        return await service.listSnapshotsPage(scope, { limit: scanLimit });
    }

    const snapshots = await service.listSnapshots(scope);
    return {
        snapshots: snapshots.slice(0, scanLimit),
        scannedGroupCount: Math.min(snapshots.length, scanLimit),
        hasMore: snapshots.length > scanLimit,
    };
}

async function listRecentGroupEvents(
    service: SpaStatisticsServiceOptions['groupStateService'],
    ref: GroupRef,
    query: StateEventListQuery,
): Promise<readonly GroupEvent[]> {
    if (service.listRecentEvents) {
        return await service.listRecentEvents(ref, query);
    }

    return listRecentStateEvents(await service.listEvents(ref), query);
}

function toActor(authSession: AuthSession) {
    return {
        principalId: authSession.clientId,
        sessionId: authSession.sessionId,
    };
}

function toSafeGroupSummary(snapshot: GroupSnapshot): SpaStatisticsSafeGroupSummary {
    return {
        groupRef: {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId,
        },
        displayName: snapshot.group.displayName,
        kind: snapshot.group.kind,
        status: snapshot.group.status,
        joinMode: snapshot.group.joinMode,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        activeSessionCount: snapshot.activeSessions.length,
        snapshotVersion: snapshot.group.snapshotVersion,
        presenceVersion: snapshot.group.presenceVersion,
    };
}

function countActiveClientSessions(snapshot: ClientSnapshot | undefined): number {
    return snapshot?.activeSessionCount ?? snapshot?.activeSessions.length ?? 0;
}

function countActorGroupPresenceSessions(
    snapshots: readonly GroupSnapshot[],
    principalId: string,
): number {
    return snapshots.reduce(
        (total, snapshot) =>
            total +
            snapshot.activeSessions.filter((session) => session.principalId === principalId).length,
        0,
    );
}

function hasActiveMember(snapshot: GroupSnapshot, principalId: string): boolean {
    return snapshot.members.some((member) =>
        member.principalId === principalId && member.status === 'active'
    );
}

function toOwnerDetails(
    snapshot: GroupSnapshot,
): GroupSpaStatisticsResponse['owner'] | undefined {
    if (
        snapshot.group.maxMembers === null &&
        snapshot.group.maxSessionsPerMember === null
    ) {
        return undefined;
    }

    return {
        maxMembers: snapshot.group.maxMembers ?? undefined,
        maxSessionsPerMember: snapshot.group.maxSessionsPerMember ?? undefined,
    };
}

function isSessionOpen(
    status: RallarServerWsStatus | undefined,
    sessionId: string | undefined,
): boolean {
    if (!status || !sessionId) {
        return false;
    }

    if (status.openConnectionIds.includes(sessionId)) {
        return true;
    }

    return status.connections.some((connection) =>
        connection.connectionId === sessionId && connection.isOpen
    );
}

function warning(
    code: SpaStatisticsWarning['code'],
    message: string,
): SpaStatisticsWarning {
    return { code, message };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }

    const normalized = Math.floor(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

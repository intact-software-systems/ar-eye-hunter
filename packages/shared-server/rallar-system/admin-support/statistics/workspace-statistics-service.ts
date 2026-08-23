import type { WorkspaceSpaStatisticsResponse } from '@shared/api/spa-statistics-types.ts';
import { canReadGroupSnapshot } from '../../group-state/policy/group-snapshot-visibility-policy.ts';
import type { ReadWorkspaceSpaStatisticsInput, SpaStatisticsDependencies } from './spa-statistics-contracts.ts';
import { countRecentGroupEvents, readBoundedGroupSnapshots } from './spa-statistics-group-reads.ts';
import {
    countActiveClientSessions,
    countActorGroupPresenceSessions,
    hasActiveMember,
    normalizePositiveInteger,
    spaStatisticsWarning,
    toSafeGroupSummary,
    toSpaStatisticsActor
} from './spa-statistics-projections.ts';

const DEFAULT_RECENT_EVENT_LIMIT = 20;
const DEFAULT_TOP_GROUPS_LIMIT = 10;
const DEFAULT_SNAPSHOT_SCAN_LIMIT = 100;

export class WorkspaceStatisticsService {
    private readonly dependencies: SpaStatisticsDependencies;
    private readonly now: () => number;
    private readonly recentEventLimit: number;
    private readonly topGroupsLimit: number;
    private readonly snapshotScanLimit: number;

    public constructor(dependencies: SpaStatisticsDependencies) {
        this.dependencies = dependencies;
        this.now = dependencies.now ?? Date.now;
        this.recentEventLimit = dependencies.recentEventLimit ?? DEFAULT_RECENT_EVENT_LIMIT;
        this.topGroupsLimit = dependencies.topGroupsLimit ?? DEFAULT_TOP_GROUPS_LIMIT;
        this.snapshotScanLimit = normalizePositiveInteger(
            dependencies.snapshotScanLimit,
            DEFAULT_SNAPSHOT_SCAN_LIMIT
        );
    }

    public async readWorkspaceSummary(
        input: ReadWorkspaceSpaStatisticsInput
    ): Promise<WorkspaceSpaStatisticsResponse> {
        const actor = toSpaStatisticsActor(input.authSession);
        const clientSnapshot = await this.dependencies.clientStateService.readSnapshot({
            ...input.scope,
            principalId: actor.principalId
        });
        const groupScan = await readBoundedGroupSnapshots(
            this.dependencies.groupStateService,
            input.scope,
            this.snapshotScanLimit
        );
        const readableGroups = groupScan.snapshots.filter((snapshot) =>
            canReadGroupSnapshot({ snapshot, actor }).allowed
        );
        const recentEventCount = await countRecentGroupEvents(
            this.dependencies.groupStateService,
            readableGroups.map((snapshot) => snapshot.group),
            this.recentEventLimit
        );

        return {
            generatedAtEpochMs: this.now(),
            scope: input.scope,
            actor: {
                ...actor,
                activeClientSessionCount: countActiveClientSessions(clientSnapshot),
                groupPresenceCount: countActorGroupPresenceSessions(
                    readableGroups,
                    actor.principalId
                )
            },
            warnings: [
                spaStatisticsWarning(
                    'policy-filtered-scan',
                    'Workspace statistics count only groups the actor can read fully.'
                ),
                spaStatisticsWarning(
                    'bounded-snapshot-scan',
                    `Workspace statistics are derived from at most ${this.snapshotScanLimit} group snapshots.`
                ),
                spaStatisticsWarning(
                    'bounded-recent-events',
                    'Activity counts are bounded recent event counts, not global exact totals.'
                )
            ],
            groups: {
                fullReadableCount: readableGroups.length,
                joinedCount: readableGroups.filter((snapshot) => hasActiveMember(snapshot, actor.principalId)).length,
                onlineMemberCount: readableGroups.reduce(
                    (total, snapshot) => total + snapshot.onlineMemberCount,
                    0
                )
            },
            activity: {
                recentVisibleGroupEventCount: {
                    count: recentEventCount,
                    limit: this.recentEventLimit,
                    bounded: true
                }
            },
            topGroups: readableGroups
                .map(toSafeGroupSummary)
                .sort(
                    (left, right) =>
                        right.onlineMemberCount - left.onlineMemberCount ||
                        right.activeSessionCount - left.activeSessionCount ||
                        left.displayName.localeCompare(right.displayName)
                )
                .slice(0, this.topGroupsLimit)
        };
    }
}

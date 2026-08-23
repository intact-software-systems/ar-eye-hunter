import type { GroupSpaStatisticsResponse } from '@shared/api/spa-statistics-types.ts';
import { canUpdateGroupSnapshot } from '../../group-state/policy/group-governance-policy.ts';
import { GroupPolicyDeniedError } from '../../group-state/policy/group-policy-result.ts';
import { canReadGroupSnapshot } from '../../group-state/policy/group-snapshot-visibility-policy.ts';
import type { ReadGroupSpaStatisticsInput, SpaStatisticsDependencies } from './spa-statistics-contracts.ts';
import { listRecentGroupEvents } from './spa-statistics-group-reads.ts';
import {
    countActorGroupPresenceSessions,
    spaStatisticsWarning,
    toOwnerDetails,
    toSafeGroupSummary,
    toSpaStatisticsActor
} from './spa-statistics-projections.ts';

const DEFAULT_RECENT_EVENT_LIMIT = 20;

export class GroupStatisticsService {
    private readonly dependencies: SpaStatisticsDependencies;
    private readonly now: () => number;
    private readonly recentEventLimit: number;

    public constructor(dependencies: SpaStatisticsDependencies) {
        this.dependencies = dependencies;
        this.now = dependencies.now ?? Date.now;
        this.recentEventLimit = dependencies.recentEventLimit ?? DEFAULT_RECENT_EVENT_LIMIT;
    }

    public async readGroupStats(
        input: ReadGroupSpaStatisticsInput
    ): Promise<GroupSpaStatisticsResponse> {
        const actor = toSpaStatisticsActor(input.authSession);
        const groupRef = { ...input.scope, groupId: input.groupId };
        const snapshot = await this.dependencies.groupStateService.readCurrentSnapshot(groupRef);
        if (!snapshot) {
            throw new Error(`Group not found: ${input.groupId}`);
        }
        const readPolicy = canReadGroupSnapshot({ snapshot, actor });
        if (!readPolicy.allowed) {
            throw new GroupPolicyDeniedError(readPolicy);
        }

        const recentEvents = await listRecentGroupEvents(
            this.dependencies.groupStateService,
            groupRef,
            { limit: this.recentEventLimit }
        );
        const safeGroup = toSafeGroupSummary(snapshot);
        const activeMember = snapshot.members.find(
            (member) => member.principalId === actor.principalId && member.status === 'active'
        );
        const owner = canUpdateGroupSnapshot({ snapshot, actor }).allowed
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
                    actor.principalId
                )
            },
            warnings: [
                spaStatisticsWarning(
                    'bounded-recent-events',
                    'Activity counts are bounded recent event counts, not global exact totals.'
                )
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
                presenceVersion: safeGroup.presenceVersion
            },
            activity: {
                recentGroupEventCount: {
                    count: recentEvents.length,
                    limit: this.recentEventLimit,
                    bounded: true
                }
            },
            ...(owner ? { owner } : {})
        };
    }
}

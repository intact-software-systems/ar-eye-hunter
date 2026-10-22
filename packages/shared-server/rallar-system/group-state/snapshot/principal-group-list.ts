import type { GroupScope } from '@shared/api/group-types.ts';

import {
    nowMs,
    recordRallarTiming,
    type RallarTimingEventInput,
    type RallarTimingSink
} from '../../observability/timing.ts';
import type { GroupStateSnapshotRepository } from '../persistence/group-state-snapshot-repository.ts';
import type { GroupStatePrincipalSnapshotList } from '../persistence/read-group-state-snapshots-for-principal.ts';
import type { CachedGroupStateServicePrincipalGroups } from './cached-group-state-service.ts';
import type { GroupStateCurrentSnapshotCache } from './group-state-current-snapshot-cache.ts';

export interface PrincipalGroupListDependencies {
    readonly repository: Pick<GroupStateSnapshotRepository, 'readSnapshotListForPrincipal'>;
    readonly currentSnapshots: Pick<GroupStateCurrentSnapshotCache, 'readSnapshots'>;
    /** Undefined with timing off: the list records nothing and reads no clock. */
    readonly timing: RallarTimingSink | undefined;
    readonly serviceId: string;
}

/** A principal's groups through the member index, assembled through the current-snapshot cache. */
export function createPrincipalGroupList(
    dependencies: PrincipalGroupListDependencies
): CachedGroupStateServicePrincipalGroups {
    const { repository, currentSnapshots, timing } = dependencies;
    if (timing === undefined) {
        return {
            listSnapshotsForPrincipal: async (scope, principalId) =>
                (await repository.readSnapshotListForPrincipal(scope, principalId, currentSnapshots)).snapshots
        };
    }
    return {
        listSnapshotsForPrincipal: async (scope, principalId) => {
            const startedAtMs = nowMs();
            const list = await repository.readSnapshotListForPrincipal(scope, principalId, currentSnapshots);
            recordRallarTiming({
                sink: timing,
                event: toPrincipalGroupListTimingEvent({ serviceId: dependencies.serviceId, scope, principalId, list }),
                status: 'ok',
                durationMs: nowMs() - startedAtMs
            });
            return list.snapshots;
        }
    };
}

interface PrincipalGroupListTiming {
    readonly serviceId: string;
    readonly scope: GroupScope;
    readonly principalId: string;
    readonly list: GroupStatePrincipalSnapshotList;
}

function toPrincipalGroupListTimingEvent(timed: PrincipalGroupListTiming): RallarTimingEventInput {
    const { list } = timed;
    return {
        component: 'group-state',
        operation: 'list-for-principal',
        serviceId: timed.serviceId,
        applicationId: timed.scope.applicationId,
        workspaceId: timed.scope.workspaceId,
        principalId: timed.principalId,
        details: {
            groups: list.snapshots.length,
            selectedMembers: list.selectedMembers,
            statements: list.statements,
            fallbackReads: list.fallbackReads
        }
    };
}

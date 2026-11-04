import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { ViewWatchAuthorization, ViewWatchAuthorizer } from '../../view-watch/compute-view-watch.ts';
import type { ViewWatchResource } from '../../view-watch/view-watch-repository.ts';
import { groupStateUpdateGroupDescriptor } from '../persistence/aggregate/group-aggregate-write-descriptors.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';

/** Point previews are limited projections available to authenticated link visitors, independently of admission. */
export class GroupSessionViewWatch implements ViewWatchAuthorizer {
    private readonly groups: Pick<GroupStateRepository, 'findGroupEntry'>;

    constructor(groups: Pick<GroupStateRepository, 'findGroupEntry'>) {
        this.groups = groups;
    }

    async read(resource: ViewWatchResource): Promise<ViewWatchAuthorization | null> {
        if (resource.family !== 'session-preview') {
            throw new TypeError('Session preview authorizer received another family');
        }
        const ref = {
            applicationId: resource.applicationId,
            workspaceId: resource.workspaceId,
            groupId: resource.resourceId
        };
        const group = await this.groups.findGroupEntry(ref);
        return group === undefined || group.value.status !== 'active' ||
                readGroupSessionSchedule(group.value.metadata) === null
            ? null
            : {
                resource,
                guard: {
                    ...groupStateUpdateGroupDescriptor(group.value, group.entry.revision),
                    operation: 'update-exact',
                    expectedValue: group.entry.value
                }
            };
    }
}

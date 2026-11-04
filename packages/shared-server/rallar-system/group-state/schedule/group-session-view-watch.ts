import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ViewWatchAuthorization, ViewWatchAuthorizer } from '../../view-watch/compute-view-watch.ts';
import { groupStateUpdateGroupDescriptor } from '../persistence/aggregate/group-aggregate-write-descriptors.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';

/** Point previews are limited projections available to authenticated link visitors, independently of admission. */
export class GroupSessionViewWatch implements ViewWatchAuthorizer {
    private readonly groups: Pick<GroupStateRepository, 'findGroupEntry'>;

    constructor(groups: Pick<GroupStateRepository, 'findGroupEntry'>) {
        this.groups = groups;
    }

    async read(ref: GroupRef): Promise<ViewWatchAuthorization | null> {
        const group = await this.groups.findGroupEntry(ref);
        return group === undefined || group.value.status !== 'active' ||
                readGroupSessionSchedule(group.value.metadata) === null
            ? null
            : { ref, guard: groupStateUpdateGroupDescriptor(group.value, group.entry.revision) };
    }
}

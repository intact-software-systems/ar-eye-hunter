import type { GroupSnapshot } from '@shared/api/group-types.ts';

import type { RuntimeStateGuardedBatch } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { groupStateUpdateGroupDescriptor } from '../persistence/aggregate/group-aggregate-write-descriptors.ts';
import type { GroupPresenceSummaryStoredRead } from '../persistence/group-state-repository-reads.ts';
import {
    groupStateInsertPresenceAdmissionDescriptor,
    groupStateUpdatePresenceAdmissionDescriptor,
    groupStateUpdatePresenceDescriptor
} from '../persistence/presence/group-presence-write-descriptors.ts';
import { computeGroupPresenceSummaryContent } from '../presence/compute-group-presence-summary.ts';

export interface GroupMoveSource {
    readonly snapshot: Pick<GroupSnapshot, 'group' | 'members' | 'activeSessions'>;
    readonly guard: RuntimeStateGuardedBatch;
}

/** Fence both selected sessions and members who can connect without changing the group row. */
export function computeGroupMoveSource(
    read: GroupPresenceSummaryStoredRead,
    nowEpochMs: number
): GroupMoveSource | null {
    if (read.group === undefined) {
        return null;
    }
    const players = read.members.filter(({ value }) => value.status === 'active' && value.role !== 'spectator');
    const playerIds = new Set(players.map(({ value }) => value.principalId));
    const admissions = new Map(read.admissions.map((stored) => [stored.value.principalId, stored]));
    const content = computeGroupPresenceSummaryContent(
        { ...read, group: read.group, current: read.current ?? null },
        nowEpochMs
    );
    return {
        snapshot: {
            group: read.group.value,
            members: read.members.map(({ value }) => value),
            activeSessions: content.activeSessions
        },
        guard: {
            guard: groupStateUpdateGroupDescriptor(read.group.value, read.group.entry.revision),
            effects: [
                ...players.map(({ value: member }) => {
                    const current = admissions.get(member.principalId);
                    return {
                        effectId: `admission:${member.principalId}`,
                        ...(current
                            ? groupStateUpdatePresenceAdmissionDescriptor(current.value, current.entry.revision)
                            : groupStateInsertPresenceAdmissionDescriptor({
                                applicationId: member.applicationId,
                                workspaceId: member.workspaceId,
                                groupId: member.groupId,
                                principalId: member.principalId,
                                admittedSessions: [],
                                updatedAtEpochMs: nowEpochMs
                            }))
                    };
                }),
                // An expired lease can be renewed without changing admission. Fence it too.
                ...read.presenceSessions.filter(({ value }) => playerIds.has(value.principalId))
                    .map(({ entry, value }) => ({
                        effectId: `presence:${value.sessionId}`,
                        ...groupStateUpdatePresenceDescriptor(value, entry.revision)
                    }))
            ]
        }
    };
}

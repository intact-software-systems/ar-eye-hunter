import type { Group } from '@shared/api/group-types.ts';
import { readRoomTimeRecords } from '@shared/api/group-deadlines/room-clock.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';

/** Program revisions reach durable members even when their only presence is in another room. */
export function computeGroupProgramPublication(
    { command, read, facts, members }: GroupMutationWriteInput,
    group: Group
): ViewInvalidationPublication {
    const operation = command.operation === 'updateGroup' ? command.input.roomClock?.operation : undefined;
    const changed = operation === 'publish-schedule' || operation === 'pause-program' || operation === 'resume-program';
    const deleted = group.status === 'deleted' && read.group?.value.status !== 'deleted';
    if (!changed && !deleted && !members.length) {
        return { outbox: [], provenance: [] };
    }
    if (!changed && !readRoomTimeRecords(group.metadata).some(record => 'phases' in record)) {
        return { outbox: [], provenance: [] };
    }
    let principalIds: string[];
    if (changed || deleted) {
        if (read.activeMembers === null) {
            throw new TypeError('Room program publication requires its captured membership');
        }
        principalIds = read.activeMembers.map(member => member.principalId);
    }
    else {
        const previous = read.activeMembers ?? [read.targetMember, read.actorMember, read.authorityMember, read.directorMember];
        principalIds = members.filter(member => {
            const previouslyActive = previous.some(row => row?.principalId === member.principalId && row.status === 'active');
            return previouslyActive !== (member.status === 'active');
        }).map(member => member.principalId);
    }
    return computeViewInvalidationPublication({
        resource: 'room-program',
        reason: changed && !deleted ? 'program-changed' : 'access-changed',
        groupId: group.groupId,
        scope: { applicationId: group.applicationId, workspaceId: group.workspaceId },
        principalIds,
        changeId: computeSha256CanonicalJson({ commandId: command.commandId, ref: command.aggregateRef, revision: group.snapshotVersion }),
        createdAtEpochMs: facts.nowEpochMs,
        retentionMs: facts.expireAtEpochMs - facts.nowEpochMs,
        serviceId: facts.serviceId,
        traceId: facts.traceId
    });
}

import type { Group } from '@shared/api/group-types.ts';
import { readRoomTimeRecords } from '@shared/api/group-deadlines/room-clock.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';

/** Program revisions reach durable members even when their only presence is in another room. */
export function computeRoomProgramPublication(
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
    if ((changed || deleted) && read.activeMembers === null) {
        throw new TypeError('Room program publication requires its captured membership');
    }
    const principalIds = changed || deleted
        ? read.activeMembers!.map(member => member.principalId)
        : members.filter(member => {
            const previouslyActive = read.activeMembers?.some(previous => previous.principalId === member.principalId) ??
                [read.targetMember, read.actorMember, read.authorityMember, read.directorMember]
                    .some(previous => previous?.principalId === member.principalId && previous.status === 'active');
            return previouslyActive !== (member.status === 'active');
        }).map(member => member.principalId);
    return computeViewInvalidationPublication({
        resource: 'room-program',
        reason: changed ? 'program-changed' : 'access-changed',
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

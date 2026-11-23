import type { Group } from '@shared/api/group-types.ts';
import { readRoomTimeRecords } from '@shared/api/group-deadlines/room-clock.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';

/** Notify durable members about named programs and notify the affected principal when access changes. */
export function computeGroupObservationPublication(
    { command, read, facts, members }: GroupMutationWriteInput,
    group: Group
): ViewInvalidationPublication {
    const clock = command.operation === 'updateGroup' ? command.input.roomClock : undefined;
    const prior = read.group?.value;
    const roomAccessChanged = prior !== undefined &&
        (group.purgeAfterEpochMs !== prior.purgeAfterEpochMs || (group.status === 'deleted' && prior.status !== 'deleted'));
    if (!clock && !roomAccessChanged && !members.length) {
        return { outbox: [], provenance: [] };
    }
    const program = clock && readRoomTimeRecords(group.metadata).find(record =>
        record.name === clock.name && ('phases' in record || 'phase' in record)
    );
    let principalIds: string[];
    if (program || roomAccessChanged) {
        if (read.activeMembers === null) {
            throw new TypeError('Room observation publication requires its captured membership');
        }
        principalIds = read.activeMembers.map(member => member.principalId);
    }
    else {
        const previous = read.group === null ? [] :
            read.activeMembers ?? [read.targetMember, read.actorMember, read.authorityMember, read.directorMember];
        principalIds = members.filter(member => {
            const previouslyActive = previous.some(row => row?.principalId === member.principalId && row.status === 'active');
            return previouslyActive !== (member.status === 'active');
        }).map(member => member.principalId);
    }
    if (!principalIds.length) {
        return { outbox: [], provenance: [] };
    }
    return computeViewInvalidationPublication({
        ...(program && !roomAccessChanged ? { resource: 'room-program', name: program.name } : { resource: 'room-access' }),
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

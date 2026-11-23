import {
    requireEpoch,
    requireExactKeys,
    requirePositiveInteger,
    requireRecord
} from '@shared/api/exact-object-decoding.ts';
import { readRoomTimeRecords } from '@shared/api/group-deadlines/room-clock.ts';
import { assertRoomDeadlineName } from '@shared/api/group-deadlines/room-deadline.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeAppOutboxSignal } from '../../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import type { GroupMutationCommand } from '../mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export interface GroupTimelineDeadline {
    readonly roomRef: GroupRef;
    readonly groupCreatedAtEpochMs: number;
    readonly publishedAtGroupRevision: number;
    readonly name: string;
    readonly revision: number;
    readonly dueAtEpochMs: number;
}

export const GROUP_TIMELINE_DEADLINE_TOPIC = 'room-timeline.deadline';

export function decodeGroupTimelineDeadline(value: unknown): GroupTimelineDeadline {
    const row = requireRecord(value, 'Timeline deadline');
    requireExactKeys(row, [
        'roomRef',
        'groupCreatedAtEpochMs',
        'publishedAtGroupRevision',
        'name',
        'revision',
        'dueAtEpochMs'
    ], 'Timeline deadline');
    const ref = requireRecord(row.roomRef, 'Timeline room');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Timeline room');
    const roomRef = assertValidRallarGroupRef(ref);
    assertRoomDeadlineName(row.name);
    requireEpoch(row.groupCreatedAtEpochMs, 'Room creation');
    requirePositiveInteger(row.publishedAtGroupRevision, 'Publication group revision');
    requirePositiveInteger(row.revision, 'Timeline revision');
    requireEpoch(row.dueAtEpochMs, 'Timeline boundary');
    return {
        roomRef,
        name: row.name,
        groupCreatedAtEpochMs: row.groupCreatedAtEpochMs,
        publishedAtGroupRevision: Number(row.publishedAtGroupRevision),
        revision: Number(row.revision),
        dueAtEpochMs: row.dueAtEpochMs
    };
}

export function groupTimelineDeadlineRoute(deadline: GroupTimelineDeadline) {
    return toAppQueueKey({
        topicId: GROUP_TIMELINE_DEADLINE_TOPIC,
        resourceId: computeSha256CanonicalJson(deadline),
        contextId: groupStateGroupStorageKey(deadline.roomRef)
    });
}

export function toTimelineSettlementCommand(deadline: GroupTimelineDeadline): GroupMutationCommand {
    const { roomRef, name, revision, dueAtEpochMs, groupCreatedAtEpochMs } = deadline;
    const commandId = 'timeline-deadline:' + groupTimelineDeadlineRoute(deadline).resourceId;
    return {
        operation: 'settleTimeline',
        aggregateRef: roomRef,
        commandId,
        requestId: commandId,
        input: {
            name,
            revision,
            dueAtEpochMs,
            groupCreatedAtEpochMs,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null
        }
    };
}

export function computeGroupTimelineDeadlines(input: {
    readonly before: Group | null;
    readonly after: Group;
    readonly createdAtEpochMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}): readonly AppOutboxInsert[] {
    const { before, after, createdAtEpochMs, serviceId, traceId } = input;
    if (after.kind !== 'room' || after.status !== 'active') {
        return [];
    }
    const prior = before?.status === 'active' ? readRoomTimeRecords(before.metadata) : [];
    const { applicationId, workspaceId, groupId } = after;
    const wakes: AppOutboxInsert[] = [];
    for (const record of readRoomTimeRecords(after.metadata)) {
        if (
            record.status !== 'running' || !('phase' in record) || !record.successor ||
            prior.some((old) => old.name === record.name && old.revision === record.revision)
        ) {
            continue;
        }
        const deadline = {
            roomRef: { applicationId, workspaceId, groupId },
            groupCreatedAtEpochMs: after.created.atEpochMs,
            publishedAtGroupRevision: after.snapshotVersion,
            name: record.name,
            revision: record.revision,
            dueAtEpochMs: record.endsAtEpochMs
        };
        wakes.push(
            computeAppOutboxSignal({
                ...groupTimelineDeadlineRoute(deadline),
                typeId: AppOutboxType.ROOM_TIMELINE_DEADLINE,
                resource: JSON.stringify(deadline),
                createdAtEpochMs,
                dueAtEpochMs: deadline.dueAtEpochMs,
                expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
                serviceId,
                traceId
            })
        );
    }
    return wakes;
}

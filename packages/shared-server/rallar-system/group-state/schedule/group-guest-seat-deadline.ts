import { requireEpoch, requireExactKeys, requirePositiveInteger, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type { Group, GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { readRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';
import { GUEST_PLAY_TIMELINE } from '@shared/api/room-guest-access.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { computeAppOutboxSignal } from '../../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '../mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export interface GroupGuestSeatDeadline {
    readonly roomRef: GroupRef;
    readonly principalId: string;
    readonly dueAtEpochMs: number;
    readonly groupRevision: number;
}

export const GROUP_GUEST_SEAT_DEADLINE_TOPIC = 'room-guest.seat-deadline';

export function decodeGroupGuestSeatDeadline(value: unknown): GroupGuestSeatDeadline {
    const deadline = requireRecord(value, 'Guest seat deadline');
    requireExactKeys(deadline, ['roomRef', 'principalId', 'dueAtEpochMs', 'groupRevision'], 'Guest seat deadline');
    const ref = requireRecord(deadline.roomRef, 'Guest seat room');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Guest seat room');
    requireString(deadline.principalId, 'Guest principal');
    if (!/^guest-[0-9a-f]{64}$/.test(deadline.principalId)) throw new TypeError('Invalid guest principal');
    requireEpoch(deadline.dueAtEpochMs, 'Guest seat deadline');
    requirePositiveInteger(deadline.groupRevision, 'Guest seat revision');
    return {
        roomRef: assertValidRallarGroupRef(ref), principalId: deadline.principalId,
        dueAtEpochMs: Number(deadline.dueAtEpochMs), groupRevision: Number(deadline.groupRevision)
    };
}

export function groupGuestSeatDeadlineRoute(deadline: GroupGuestSeatDeadline) {
    return toAppQueueKey({
        topicId: GROUP_GUEST_SEAT_DEADLINE_TOPIC, contextId: groupStateGroupStorageKey(deadline.roomRef),
        resourceId: computeSha256CanonicalJson(deadline)
    });
}

export function toGroupGuestSeatExpiryCommand(deadline: GroupGuestSeatDeadline): GroupMutationCommand {
    const commandId = 'guest-expiry:' + groupGuestSeatDeadlineRoute(deadline).resourceId;
    return {
        operation: 'removeGroupMember', aggregateRef: deadline.roomRef, commandId, requestId: commandId,
        targetPrincipalId: deadline.principalId, input: { actorPrincipalId: null, actorSessionId: null, reason: null }
    };
}

interface GroupGuestDeadlineChanges {
    readonly group: Group;
    readonly previous: Group | null;
    readonly newlyAdmitted: readonly GroupMember[];
    readonly timelineChanged: boolean;
    readonly facts: GroupMutationFacts;
}

export function computeGroupGuestSeatDeadlines({ group, previous, newlyAdmitted, timelineChanged, facts }: GroupGuestDeadlineChanges): readonly AppOutboxInsert[] {
    const dueByPrincipal = new Map<string, number>();
    for (const member of newlyAdmitted) {
        if (member.guestLease && member.status === 'active') {
            dueByPrincipal.set(member.principalId, member.guestLease.expiresAtEpochMs);
        }
    }
    if (timelineChanged) {
        const before = previous && readRoomTimeline(previous.metadata, GUEST_PLAY_TIMELINE)?.guestParticipants || [];
        const after = readRoomTimeline(group.metadata, GUEST_PLAY_TIMELINE)?.guestParticipants ?? [];
        for (const held of after) {
            if (held.endsAtEpochMs > held.leaseExpiresAtEpochMs &&
                !before.some(entry => entry.principalId === held.principalId && entry.endsAtEpochMs === held.endsAtEpochMs)) {
                dueByPrincipal.set(held.principalId, held.endsAtEpochMs);
            }
        }
        for (const old of before) {
            if (facts.attemptAtEpochMs >= old.leaseExpiresAtEpochMs && !after.some(entry => entry.principalId === old.principalId)) {
                dueByPrincipal.set(old.principalId, facts.attemptAtEpochMs);
            }
        }
    }
    const { applicationId, workspaceId, groupId } = group;
    return Array.from(dueByPrincipal, ([principalId, dueAtEpochMs]) => {
        const deadline = { roomRef: { applicationId, workspaceId, groupId }, principalId, dueAtEpochMs, groupRevision: group.snapshotVersion };
        return computeAppOutboxSignal({
            ...groupGuestSeatDeadlineRoute(deadline), typeId: AppOutboxType.ROOM_GUEST_SEAT_DEADLINE,
            resource: JSON.stringify(deadline), dueAtEpochMs, createdAtEpochMs: facts.nowEpochMs,
            expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP, serviceId: facts.serviceId, traceId: facts.traceId
        });
    });
}

import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { GUEST_PLAY_TIMELINE, roomGuestCredentialExpiresAt } from '@shared/api/room-guests/access.ts';
import { ROOM_GUEST_LIFETIME_MS } from '@shared/api/room-guests/invitation.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { roomGuestTransportSessionId } from '../../../auth/credentials/room-guest-credential.ts';
import type { AuthSessionPersistence } from '../../../auth/persistence/auth-session-persistence.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../../../auth/persistence/auth-storage-keys.ts';
import type { GroupMutationCommand, GroupMutationDomainWrite, GroupMutationRead } from '../group-mutation-contracts.ts';

export async function readRoomGuestTransportRows(repository: AuthSessionPersistence, command: GroupMutationCommand, read: GroupMutationRead) {
    if (!read.group || read.idempotency) return [];
    const ids = new Set<string>();
    if (command.operation === 'updateGroup' && command.input.roomClock?.name === GUEST_PLAY_TIMELINE) {
        const round = readRoomTimeline(read.group.value.metadata, GUEST_PLAY_TIMELINE);
        for (const guest of round?.guestParticipants ?? []) ids.add(guest.principalId);
        if (command.input.roomClock.operation === 'advance-phase') {
            for (const id of command.input.roomClock.participantPrincipalIds ?? []) {
                if (/^guest-[0-9a-f]{64}$/.test(id)) ids.add(id);
            }
        }
    }
    if (read.targetMember?.guestLease && (command.operation === 'removeGroupMember' || command.operation === 'banGroupMember' ||
        command.operation === 'upsertMember')) ids.add(read.targetMember.principalId);
    const rows = await Promise.all(Array.from(ids, async id => repository.findSessionBySessionIdEntry(await roomGuestTransportSessionId(id))));
    return rows.filter(row => row !== undefined).filter(row => row.value.guestRoom && isSameGroupRef(row.value.guestRoom, command.aggregateRef));
}

/** The clock and its WS/reconnect lifetime commit under the same group revision. */
export function roomGuestTransportEffects(computed: GroupMutationDomainWrite, read: GroupMutationRead): RuntimeStateGuardedBatchEffect[] {
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    if (!read.guestTransportRows?.length || computed.guard.kind !== 'group') return effects;
    for (const { entry, value } of read.guestTransportRows) {
        const identity = { effectId: 'guest-transport:' + value.clientId, namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            key: entry.key, expectedRevision: entry.revision };
        if (computed.members.some(member => member.principalId === value.clientId && member.status !== 'active')) {
            effects.push({ ...identity, operation: 'delete' });
            continue;
        }
        const expiresAtEpochMs = roomGuestCredentialExpiresAt(computed.guard.value, { principalId: value.clientId,
            guestLease: { admittedAtEpochMs: value.issuedAtEpochMs, expiresAtEpochMs: value.issuedAtEpochMs + ROOM_GUEST_LIFETIME_MS } });
        if (expiresAtEpochMs !== value.expiresAtEpochMs) {
            effects.push({ ...identity, operation: 'update-exact', expectedValue: entry.value,
                expireAtTimestamp: expiresAtEpochMs, value: encodeRuntimeStateJsonValue({ ...value, expiresAtEpochMs }) });
        }
    }
    return effects;
}

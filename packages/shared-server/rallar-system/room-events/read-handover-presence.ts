import { playerOffer } from '@shared/api/room-events/room-event-courts.ts';
import { isLiveGroupPresenceSession } from '../group-state/policy/group-policy-primitives.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { fenceRuntimeStateEntry } from '../../runtime-state/guarded-batch/fence-runtime-state-entry.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import { GroupMutationAuthorizationError } from '../group-state/group-mutation-authority.ts';
import { isExactlyAdmitted } from '../group-state/mutation/aggregate/group-aggregate-mutation-policy.ts';
import { PRESENCE_ADMISSIONS_NAMESPACE, SESSIONS_NAMESPACE } from '../group-state/persistence/group-state-runtime-namespaces.ts';
import type { RoomEventAuthority } from './room-event-authority.ts';

interface HandoverPresenceInput extends RoomEventAuthority.Dependencies {
    readonly event: RoomEvent;
    readonly recipientId: string;
    readonly now: number;
    readonly acceptingSession?: string;
}

export async function readHandoverPresence(input: HandoverPresenceInput): Promise<RuntimeStateGuardedBatchEffect[]> {
    const { groups, authSessions, event, recipientId, now, acceptingSession } = input;
    const seat = playerOffer(event, recipientId);
    const rooms = [event.lobby];
    if (seat?.deadline === null) rooms.push({ ...event.lobby, groupId: seat.groupId });
    for (const room of rooms) {
        const admission = await groups.findPresenceAdmissionEntry({ ...room, principalId: recipientId });
        if (!admission) continue;
        for (const candidate of admission.value.admittedSessions) {
            if (acceptingSession !== undefined && candidate.sessionId !== acceptingSession) continue;
            const present = await groups.findPresenceEntry({ ...room, sessionId: candidate.sessionId });
            if (!present || !isLiveGroupPresenceSession(present.value, now) || !isExactlyAdmitted(admission.value, present.value)) continue;
            const fences = [fenceRuntimeStateEntry(PRESENCE_ADMISSIONS_NAMESPACE, admission.entry), fenceRuntimeStateEntry(SESSIONS_NAMESPACE, present.entry)];
            // Acceptance already fences this issued session through the actor check.
            if (acceptingSession === undefined) {
                const issued = await authSessions.findSessionBySessionIdEntry(candidate.sessionId);
                if (!issued || issued.value.guestRoom || issued.value.clientId !== recipientId || issued.value.expiresAtEpochMs <= now) continue;
                fences.push(fenceRuntimeStateEntry(AUTH_SESSIONS_BY_SESSION_NAMESPACE, issued.entry));
            }
            return fences;
        }
    }
    throw new GroupMutationAuthorizationError('The handover recipient must be present in the event.');
}

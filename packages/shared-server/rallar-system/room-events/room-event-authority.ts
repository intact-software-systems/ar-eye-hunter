import { playerOffer } from '@shared/api/room-events/room-event-courts.ts';
import { isLiveGroupPresenceSession } from '../group-state/policy/group-policy-primitives.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import type { RoomGuestLease } from '@shared/api/room-guests/invitation.ts';
import { isRallarGroupDirectorSessionActive } from '@shared/api/group-director.ts';
import type { GroupMember, GroupRef } from '@shared/api/group-types.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import { GroupMutationAuthorizationError } from '../group-state/group-mutation-authority.ts';
import { isExactlyAdmitted } from '../group-state/mutation/aggregate/group-aggregate-mutation-policy.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { GROUPS_NAMESPACE, PRESENCE_ADMISSIONS_NAMESPACE, SESSIONS_NAMESPACE } from '../group-state/persistence/group-state-runtime-namespaces.ts';
import type { RoomEventActor } from './room-event-command.ts';

export namespace RoomEventAuthority {
    export interface Dependencies {
        readonly groups: GroupStateRepository;
        readonly authSessions: Pick<AuthSessionPersistence, 'findSessionBySessionIdEntry'>;
    }
    export interface Verified {
        readonly fences: readonly RuntimeStateGuardedBatchEffect[];
        readonly audience: readonly string[];
        readonly guestLease?: RoomGuestLease;
    }
}

/** The roster and session that authorized the command are fenced in the event transaction. */
export class RoomEventAuthority {
    private readonly dependencies: RoomEventAuthority.Dependencies;
    private readonly organizers: readonly string[];

    private readonly organizersByApplication: Readonly<Record<string, readonly string[]>>;

    constructor(dependencies: RoomEventAuthority.Dependencies, organizers: readonly string[], organizersByApplication: Readonly<Record<string, readonly string[]>> = {}) {
        this.organizersByApplication = organizersByApplication;
        this.dependencies = dependencies;
        this.organizers = organizers;
    }

    async read(input: RoomEventActor & {lobby: GroupRef; command?: RoomEvent.Command}, event: RoomEvent | null, now: number): Promise<RoomEventAuthority.Verified & { readonly members: readonly GroupMember[] }> {
        const { groups, authSessions } = this.dependencies;
        const [lobby, session] = await Promise.all([
            groups.findGroupEntry(input.lobby), authSessions.findSessionBySessionIdEntry(input.sessionId)
        ]);
        if (!lobby || lobby.value.status !== 'active' || (lobby.value.expiresAtEpochMs !== null && lobby.value.expiresAtEpochMs <= now) ||
            !session || session.value.clientId !== input.principalId || session.value.expiresAtEpochMs <= now ||
            event?.removed.includes(input.principalId)) {
            throw new GroupMutationAuthorizationError('A current lobby membership and session are required.');
        }
        if (event && !await groups.isTemporaryGroupAvailable(lobby.value, now)) {
            throw new GroupMutationAuthorizationError('Event access has ended.');
        }
        const members = await groups.listMembers(input.lobby);
        const active = members.filter(member => member.status === 'active' && (!member.guestLease || roomGuestAccessMode(lobby.value, member, now) === 'room'));
        const audience = active.map(member => member.principalId);
        const actor = active.find(member => member.principalId === input.principalId);
        if (!actor) throw new GroupMutationAuthorizationError('Event lobby access has ended.');
        const command = input.command;
        const permitted = this.canOrganize(input.lobby.applicationId, input.principalId);
        if (command?.action === 'create' && (session.value.guestRoom || lobby.value.ownerPrincipalId !== input.principalId ||
            !permitted)) {
            throw new GroupMutationAuthorizationError('Configured organizer permission and control of the lobby are required.');
        }
        if (command?.action === 'propose' && command.players.some(player => !audience.includes(player) || event?.removed.includes(player))) {
            throw new GroupMutationAuthorizationError('A party can invite only current event players.');
        }
        const fences = [fence(GROUPS_NAMESPACE, lobby.entry), fence(AUTH_SESSIONS_BY_SESSION_NAMESPACE, session.entry)];
        if (command?.action === 'offer-handover' || command?.action === 'accept-handover') {
            const offering = command.action === 'offer-handover';
            const recipientId = offering ? command.recipientId : input.principalId;
            const recipient = active.find(member => member.principalId === recipientId);
            if (!event || !recipient || recipient.guestLease || !this.canOrganize(input.lobby.applicationId, recipientId) ||
                (offering ? event.organizerId !== input.principalId : event.handover?.recipientId !== input.principalId)) {
                throw new GroupMutationAuthorizationError('Handover requires an eligible event organizer.');
            }
            fences.push(...await this.recipientPresence(event, recipientId, now, offering ? undefined : input.sessionId));
        }
        if (command?.action === 'release' && input.principalId !== event?.organizerId) {
            const court = { ...input.lobby, groupId: command.groupId };
            if (!event?.courts.some(candidate => candidate.groupId === court.groupId) ||
                (session.value.guestRoom && !isSameGroupRef(session.value.guestRoom, court))) {
                throw new GroupMutationAuthorizationError('Release requires the assigned court director.');
            }
            fences.push(...await this.directorFences(court, input, now));
        }
        else if (session.value.guestRoom && !isSameGroupRef(input.lobby, session.value.guestRoom)) {
            throw new GroupMutationAuthorizationError('This guest credential belongs to another room.');
        }
        return { fences, audience, members: active, guestLease: actor.guestLease };
    }

    private canOrganize(applicationId: string, principalId: string): boolean {
        return this.organizers.includes(principalId) || (Object.hasOwn(this.organizersByApplication, applicationId) &&
            this.organizersByApplication[applicationId].includes(principalId));
    }

    private async recipientPresence(event: RoomEvent, recipientId: string, now: number, acceptingSession?: string): Promise<RuntimeStateGuardedBatchEffect[]> {
        const { groups, authSessions } = this.dependencies;
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
                const fences = [fence(PRESENCE_ADMISSIONS_NAMESPACE, admission.entry), fence(SESSIONS_NAMESPACE, present.entry)];
                // Acceptance already fences this issued session through the actor check.
                if (acceptingSession === undefined) {
                    const issued = await authSessions.findSessionBySessionIdEntry(candidate.sessionId);
                    if (!issued || issued.value.guestRoom || issued.value.clientId !== recipientId || issued.value.expiresAtEpochMs <= now) continue;
                    fences.push(fence(AUTH_SESSIONS_BY_SESSION_NAMESPACE, issued.entry));
                }
                return fences;
            }
        }
        throw new GroupMutationAuthorizationError('The handover recipient must be present in the event.');
    }

    private async directorFences(court: GroupRef, actor: RoomEventActor, now: number): Promise<RuntimeStateGuardedBatchEffect[]> {
        const groups = this.dependencies.groups;
        const [group, presence, admission, member] = await Promise.all([groups.findGroupEntry(court),
            groups.findPresenceEntry({ ...court, sessionId: actor.sessionId }), groups.findPresenceAdmissionEntry({ ...court, principalId: actor.principalId }),
            groups.findMember({ ...court, principalId: actor.principalId })]);
        const director = readRallarGroupDirectorAppointment(group?.value.metadata);
        if (!group || group.value.status !== 'active' || director?.principalId !== actor.principalId || director.sessionId !== actor.sessionId ||
            !presence || !admission || !member || presence.value.disconnectedAtEpochMs !== null ||
            !isRallarGroupDirectorSessionActive({ group: group.value, members: [member], activeSessions: [presence.value] }, director, now) ||
            presence.value.principalId !== actor.principalId || !isExactlyAdmitted(admission.value, presence.value)) {
            throw new GroupMutationAuthorizationError('A current court director and live appointment are required to release the court.');
        }
        return [fence(GROUPS_NAMESPACE, group.entry), fence(SESSIONS_NAMESPACE, presence.entry), fence(PRESENCE_ADMISSIONS_NAMESPACE, admission.entry)];
    }
}

function fence(namespace: string, row: RuntimeStateEntry): RuntimeStateGuardedBatchEffect {
    return { operation: 'update-exact', effectId: namespace + ':' + row.key, namespace, key: row.key, expectedRevision: row.revision,
        expectedValue: row.value, value: row.value, expireAtTimestamp: row.expireAtTimestamp };
}

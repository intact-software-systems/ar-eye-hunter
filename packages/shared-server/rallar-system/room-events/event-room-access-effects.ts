import { computeEventRoomChange, type RoomChange, type RoomChangeRead } from './compute-event-room-change.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { type RoomEvent } from '@shared/api/room-events/room-event.ts';
import type { RoomGuestLease } from '@shared/api/room-guests/invitation.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import { computeMutationCommandDigest, decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { mutationDescriptor, toGroupMutationEventId } from '../group-state/group-mutation-authority.ts';
import { toAggregateMutationCommand, toMembershipMutationCommand } from '../group-state/group-mutation-command.ts';
import type { GroupMutationCommand, GroupMutationComputedWrite } from '../group-state/mutation/group-mutation-contracts.ts';
import type { GroupGuestAdmission } from '../group-state/mutation/membership/group-guest-admission.ts';
import { readGroupGuestTransportRows } from '../group-state/mutation/membership/group-guest-transport-lifecycle.ts';
import { readGroupMutation } from '../group-state/mutation/read/read-group-mutation.ts';
import { writeGroupMutation } from '../group-state/mutation/write/write-group-mutation.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';

export namespace EventRoomAccessEffects {
    export interface Dependencies {
        readonly groups: GroupStateRepository;
        readonly sessions: AuthSessionPersistence;
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
    }
    export interface Input {
        readonly before: RoomEvent | null;
        readonly after: RoomEvent;
        readonly command: RoomEvent.Command;
        readonly lobbyRef: GroupRef;
        readonly actor: { readonly principalId: string; readonly sessionId: string } | null;
        readonly guestTransport?: GroupGuestAdmission.Transport;
        readonly actorGuestLease?: RoomGuestLease;
        readonly requestId: string;
        readonly nowEpochMs: number;
        readonly traceId: string;
    }
}

/** The enclosing event command commits these normal room writes together with its queue revision. */
export class EventRoomAccessEffects {
    private readonly dependencies: EventRoomAccessEffects.Dependencies;
    constructor(dependencies: EventRoomAccessEffects.Dependencies) { this.dependencies = dependencies; }

    async prepare(input: EventRoomAccessEffects.Input): Promise<readonly GroupMutationComputedWrite[]> {
        const changes = eventRoomChanges(input);
        return (await Promise.all([...changes].map(async ([groupId, roomChanges]) => {
            const ref = { ...input.lobbyRef, groupId };
            const reads = await Promise.all(roomChanges.map(change => this.readChange(input, ref, change)));
            const initial = reads[0]?.read.group;
            const writes: GroupMutationComputedWrite[] = [];
            let group = initial;
            for (const [index, change] of roomChanges.entries()) {
                const data = reads[index]!;
                if (data.read.group?.entry.revision !== initial?.entry.revision) throw new RuntimeStateWriteConflictError();
                const current = { ...data, read: { ...data.read, group: group ?? null } };
                const computed = computeEventRoomChange(input, change, current);
                if (!computed) continue;
                if (computed.outcome !== 'write' || computed.guard.kind !== 'group') throw new TypeError('Event room access change refused.');
                writes.push(computed);
                if (group) group = { value: computed.guard.value, entry: { ...group.entry,
                    revision: group.entry.revision + 1, value: JSON.stringify(computed.guard.value) } };
            }
            return writes;
        }))).flat();
    }

    async write(transaction: PSqlSql, writes: readonly GroupMutationComputedWrite[]): Promise<void> {
        for (const write of writes) await writeGroupMutation(transaction, write);
    }

    private async readChange(input: EventRoomAccessEffects.Input, ref: GroupRef, change: RoomChange): Promise<RoomChangeRead> {
        const command = roomCommand(input, ref, change);
        const { read } = await readGroupMutation({ repository: this.dependencies.groups, command, authSessionId: null });
        const guestTransportRows = await readGroupGuestTransportRows(this.dependencies.sessions, command, read);
        const commandHash = computeMutationCommandDigest(decodeJsonWireValue(command, 'Event room change'));
        const now = input.nowEpochMs;
        return { ref, command, read: { ...read, guestTransportRows }, facts: {
            authenticatedAuthority: input.actor, internalAuthority: 'none', commandHash,
            eventId: toGroupMutationEventId(commandHash, now), serviceId: this.dependencies.serviceId,
            nowEpochMs: now, attemptAtEpochMs: now, attemptCount: 1, traceId: input.traceId,
            expireAtEpochMs: now + this.dependencies.finishedRetentionMs, resolvedJoinCode: null, joinCodeVerifier: null,
            capacity: { defaultMaxMembers: null }
        } };
    }
}

function eventRoomChanges(input: EventRoomAccessEffects.Input): Map<string, RoomChange[]> {
    const { before, after, command, lobbyRef } = input;
    const changes = new Map<string, RoomChange[]>();
    const add = (id: string, change: RoomChange) => changes.set(id, [...(changes.get(id) ?? []), change]);
    if (!before) {
        add(lobbyRef.groupId, { kind: 'attach' });
        for (const court of after.courts) add(court.groupId, { kind: 'open', capacity: court.capacity });
        return changes;
    }
    for (const court of after.courts) {
        const old = before.courts.find(c => c.groupId === court.groupId)!;
        const previous = new Set(old.seats.filter(seat => seat.deadline === null).map(seat => seat.principalId));
        const current = new Set(court.seats.filter(seat => seat.deadline === null).map(seat => seat.principalId));
        for (const principal of previous) if (!current.has(principal)) add(court.groupId, { kind: 'release', principal });
        for (const principal of current) if (!previous.has(principal)) add(court.groupId, { kind: 'admit', principal });
        if (after.closed && !before.closed) add(court.groupId, { kind: 'close' });
    }
    if (command.action === 'remove') {
        add(lobbyRef.groupId, { kind: 'remove', principal: command.targetId });
        if (command.rotateVerifier) add(lobbyRef.groupId, { kind: 'rotate', verifier: command.rotateVerifier });
    }
    if (after.closed && !before.closed) add(lobbyRef.groupId, { kind: 'close' });
    return changes;
}

function roomCommand(input: EventRoomAccessEffects.Input, roomRef: GroupRef, change: RoomChange): GroupMutationCommand {
    const stamp = computeSha256CanonicalJson({ request: input.requestId, lobby: input.lobbyRef.groupId, group: roomRef.groupId,
        revision: input.after.revision, operation: change.kind, principal: 'principal' in change ? change.principal : null });
    const requestId = 'event-' + stamp;
    const actor = { actorPrincipalId: input.actor?.principalId, actorSessionId: input.actor?.sessionId, requestId };
    const scope = { scope: roomRef, groupId: roomRef.groupId };
    if (change.kind === 'open') return toAggregateMutationCommand(mutationDescriptor({ ...scope, operation: 'createGroup', request: {
        ...actor, groupId: roomRef.groupId, createdByPrincipalId: input.after.organizerId, displayName: roomRef.groupId,
        kind: 'room', joinMode: 'invite-only', directoryListing: 'unlisted', expiresAtEpochMs: input.after.closesAt,
        maxMembers: change.capacity, maxSpectators: 0
    }}), () => requestId);
    if ('principal' in change) return toMembershipMutationCommand(mutationDescriptor({ ...scope, operation: 'upsertMember',
        targetPrincipalId: change.principal, request: { ...actor, status: change.kind === 'admit' ? 'active' : 'left' }
    }), () => requestId);
    return toAggregateMutationCommand(mutationDescriptor({ ...scope, operation: 'updateGroup', request: actor }), () => requestId);
}

import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch } from '../exact-object-decoding.ts';
import { createRallarGroupDirectorAppointment, mergeRallarGroupDirectorMetadata, readRallarGroupDirectorAppointment } from '../group-director.ts';
import { readRoomDirectorSuccession, storeRoomDirectorSuccession, type RoomDirectorSuccession } from './room-director-succession-record.ts';
import { observeRoomDirectorLoss, settleDirectorLeaseLoss } from './room-director-succession-presence.ts';
import type { GroupSnapshot } from '../group-types.ts';


interface DirectorChangeInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: { readonly principalId: string; readonly sessionId: string };
    readonly command: RoomDirectorSuccession.Command;
    readonly nowEpochMs: number;
}
type DirectorChange = { readonly metadata: ApiJsonObject } |
    { readonly rejectionCode: 'room-director-changed' | 'group-mutation-rejected'; readonly message: string };

const defaults: RoomDirectorSuccession = {
    revision: 0, directorLeaseExpiresAtEpochMs: null, deputyPrincipalId: null, reconnectWindowMs: 30000, deputyWindowMs: 30000, spectatorDirectorEpoch: null, loss: null
};

export function changeRoomDirectorSuccession(input: DirectorChangeInput): DirectorChange {
    const { snapshot, actor, command, nowEpochMs } = input;
    requireEpoch(nowEpochMs, 'Director change time');
    const metadata = settleDirectorLeaseLoss(snapshot.group.metadata, nowEpochMs);
    const previous = readRallarGroupDirectorAppointment(metadata);
    const state = readRoomDirectorSuccession(metadata) ?? defaults;
    if ((previous?.epoch ?? 0) !== command.expectedDirectorEpoch) {
        return { rejectionCode: 'room-director-changed', message: 'The director appointment has changed.' };
    }
    const actorMember = snapshot.members.find(member => member.principalId === actor.principalId && member.status === 'active');
    if (snapshot.group.kind !== 'room' || snapshot.group.status !== 'active' || !actorMember) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Director succession requires active room membership.' };
    }
    if (command.operation === 'configure' || command.operation === 'appoint') {
        if (actorMember.role !== 'owner' && actorMember.role !== 'admin') {
            return { rejectionCode: 'group-mutation-rejected', message: 'Only a room owner or admin can appoint or configure.' };
        }
        if (command.operation === 'configure') {
            if (command.expectedRevision !== (readRoomDirectorSuccession(snapshot.group.metadata)?.revision ?? 0)) return { rejectionCode: 'room-director-changed', message: 'The succession policy has changed.' };
            if (command.deputyPrincipalId !== null && command.deputyPrincipalId === previous?.principalId) return { rejectionCode: 'group-mutation-rejected', message: 'Designate someone other than the director as deputy.' };
            if (command.deputyPrincipalId !== null && !snapshot.members.some(member =>
                member.principalId === command.deputyPrincipalId && member.status === 'active')) {
                return { rejectionCode: 'group-mutation-rejected', message: 'The deputy must be an active room member.' };
            }
            const currentSession = previous && snapshot.activeSessions.find(session => session.principalId === previous.principalId &&
                session.sessionId === previous.sessionId && session.status === 'active' && session.expiresAtEpochMs > nowEpochMs);
            const configured = storeRoomDirectorSuccession(metadata, { ...state, deputyPrincipalId: command.deputyPrincipalId,
                directorLeaseExpiresAtEpochMs: state.directorLeaseExpiresAtEpochMs ?? currentSession?.expiresAtEpochMs ?? null,
                reconnectWindowMs: command.reconnectWindowMs ?? state.reconnectWindowMs, deputyWindowMs: command.deputyWindowMs ?? state.deputyWindowMs });
            return { metadata: previous && !currentSession && !state.loss ? observeRoomDirectorLoss(configured, nowEpochMs) : configured };
        }
        return appoint(input, state, { principalId: command.targetPrincipalId, sessionId: command.targetSessionId });
    }
    const { loss } = state;
    if (!loss || loss.directorEpoch !== command.expectedDirectorEpoch || nowEpochMs < loss.reconnectUntilEpochMs) {
        return { rejectionCode: 'group-mutation-rejected', message: 'The director appointment is still reserved.' };
    }
    if (command.operation === 'claim-player') {
        if (actorMember.role === 'spectator' || (state.deputyPrincipalId !== null && !loss.declined && nowEpochMs < loss.deputyUntilEpochMs)) {
            return { rejectionCode: 'group-mutation-rejected', message: 'The player has no current claim.' };
        }
        return appoint(input, state, actor);
    }
    if (loss.declined || actor.principalId !== state.deputyPrincipalId || nowEpochMs >= loss.deputyUntilEpochMs) {
        return { rejectionCode: 'group-mutation-rejected', message: 'The designated deputy has no current claim.' };
    }
    if (command.operation === 'decline-deputy') {
        return { metadata: storeRoomDirectorSuccession(metadata, { ...state, loss: { ...loss, declined: true } }) };
    }
    return appoint(input, state, actor);
}

function appoint({ snapshot, nowEpochMs }: DirectorChangeInput, state: RoomDirectorSuccession, { principalId, sessionId }: DirectorChangeInput['actor']): DirectorChange {
    const target = snapshot.members.find(member => member.principalId === principalId && member.status === 'active');
    const present = snapshot.activeSessions.find(session => session.principalId === principalId && session.sessionId === sessionId &&
        session.status === 'active' && session.disconnectedAtEpochMs === null && session.expiresAtEpochMs > nowEpochMs);
    if (!target || !present) return { rejectionCode: 'group-mutation-rejected', message: 'The appointee must have an admitted room session.' };
    const previous = readRallarGroupDirectorAppointment(snapshot.group.metadata);
    const appointment = createRallarGroupDirectorAppointment({ session: { clientId: principalId, sessionId }, previous, now: nowEpochMs });
    requireEpoch(appointment.epoch, 'New director epoch');
    const metadata = mergeRallarGroupDirectorMetadata(snapshot.group.metadata, appointment);
    return { metadata: storeRoomDirectorSuccession(metadata, { ...state, loss: null, directorLeaseExpiresAtEpochMs: present.expiresAtEpochMs,
        deputyPrincipalId: state.deputyPrincipalId === principalId ? null : state.deputyPrincipalId, spectatorDirectorEpoch: target.role === 'spectator' ? appointment.epoch : null }) };
}

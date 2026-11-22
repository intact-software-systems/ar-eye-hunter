import type { ApiJsonObject } from './api-json-value.ts';
import { requireEpoch } from './exact-object-decoding.ts';
import { createRallarGroupDirectorAppointment, mergeRallarGroupDirectorMetadata, readRallarGroupDirectorAppointment } from './group-director.ts';
import { readRoomDirectorSuccession, storeRoomDirectorSuccession, type RoomDirectorSuccession } from './group-director-succession-record.ts';
import type { GroupMember, GroupSnapshot } from './group-types.ts';

export { decodeRoomDirectorSuccessionCommand, readRoomDirectorSuccession, ROOM_DIRECTOR_SUCCESSION_METADATA_KEY, type RoomDirectorSuccession } from './group-director-succession-record.ts';

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

export function observeRoomDirectorLoss(metadata: ApiJsonObject, lostAtEpochMs: number): ApiJsonObject {
    requireEpoch(lostAtEpochMs, 'Director loss time');
    const state = readRoomDirectorSuccession(metadata);
    const director = readRallarGroupDirectorAppointment(metadata);
    if (!state || !director || state.loss?.directorEpoch === director.epoch) return metadata;
    const start = Math.max(Math.min(lostAtEpochMs, state.directorLeaseExpiresAtEpochMs ?? lostAtEpochMs), director.appointedAtEpochMs);
    const reconnectUntilEpochMs = start + state.reconnectWindowMs;
    const deputyUntilEpochMs = reconnectUntilEpochMs + (state.deputyPrincipalId === null ? 0 : state.deputyWindowMs);
    requireEpoch(deputyUntilEpochMs, 'Deputy cutoff');
    return storeRoomDirectorSuccession(metadata, { ...state, loss: {
        directorEpoch: director.epoch, lostAtEpochMs: start, reconnectUntilEpochMs, deputyUntilEpochMs, declined: false
    } });
}

export function recoverRoomDirector(metadata: ApiJsonObject, principalId: string, sessionId: string, nowEpochMs: number): ApiJsonObject {
    requireEpoch(nowEpochMs, 'Director recovery time');
    const state = readRoomDirectorSuccession(metadata);
    const director = readRallarGroupDirectorAppointment(metadata);
    if (!state?.loss || !director || state.loss.directorEpoch !== director.epoch || director.sessionId !== sessionId ||
        director.principalId !== principalId || nowEpochMs < state.loss.lostAtEpochMs || nowEpochMs >= state.loss.reconnectUntilEpochMs) return metadata;
    return storeRoomDirectorSuccession(metadata, { ...state, loss: null });
}

/** Renewing an uninterrupted lease updates the durable loss anchor without publishing a new policy or succession revision. */
export function observeRoomDirectorPresence(
    metadata: ApiJsonObject, principalId: string, sessionId: string, atEpochMs: number, expiresAtEpochMs: number
): ApiJsonObject {
    requireEpoch(atEpochMs, 'Presence observation time');
    requireEpoch(expiresAtEpochMs, 'Director lease end');
    const initial = readRoomDirectorSuccession(metadata);
    const director = readRallarGroupDirectorAppointment(metadata);
    if (!initial || director?.principalId !== principalId || director.sessionId !== sessionId || expiresAtEpochMs <= atEpochMs) return metadata;
    const afterGap = settleDirectorLeaseLoss(metadata, atEpochMs);
    const recovered = recoverRoomDirector(afterGap, principalId, sessionId, atEpochMs);
    const state = readRoomDirectorSuccession(recovered)!;
    if (state.loss || (state.directorLeaseExpiresAtEpochMs !== null && state.directorLeaseExpiresAtEpochMs >= expiresAtEpochMs)) return recovered;
    return storeRoomDirectorSuccession(recovered, { ...state, directorLeaseExpiresAtEpochMs: expiresAtEpochMs }, true);
}

export function settleDirectorLeaseLoss(metadata: ApiJsonObject, nowEpochMs: number): ApiJsonObject {
    const state = readRoomDirectorSuccession(metadata);
    const end = state?.directorLeaseExpiresAtEpochMs;
    return !state?.loss && end != null && end <= nowEpochMs ? observeRoomDirectorLoss(metadata, end) : metadata;
}

export function observeRoomDirectorMembership(metadata: ApiJsonObject, member: GroupMember, nowEpochMs: number): ApiJsonObject {
    const state = readRoomDirectorSuccession(metadata);
    if (!state) return metadata;
    const director = readRallarGroupDirectorAppointment(metadata);
    const departedDeputy = member.principalId === state.deputyPrincipalId && member.status !== 'active';
    const revoked = director?.principalId === member.principalId && (member.status !== 'active' ||
        (member.role === 'spectator' && state.spectatorDirectorEpoch !== director.epoch));
    if (!departedDeputy && !revoked) return metadata;
    const deputyPrincipalId = departedDeputy ? null : state.deputyPrincipalId;
    let loss = state.loss;
    if (revoked && director) {
        if (loss?.directorEpoch !== director.epoch || loss.reconnectUntilEpochMs !== loss.lostAtEpochMs) {
            requireEpoch(nowEpochMs, 'Director revocation time');
            const deputyUntilEpochMs = nowEpochMs + (deputyPrincipalId ? state.deputyWindowMs : 0);
            requireEpoch(deputyUntilEpochMs, 'Deputy cutoff');
            loss = { directorEpoch: director.epoch, lostAtEpochMs: nowEpochMs, reconnectUntilEpochMs: nowEpochMs, deputyUntilEpochMs, declined: false };
        }
    }
    if (departedDeputy && loss) loss = { ...loss, declined: true };
    if (loss === state.loss && !departedDeputy) return metadata;
    return storeRoomDirectorSuccession(metadata, { ...state, deputyPrincipalId, loss,
        spectatorDirectorEpoch: revoked ? null : state.spectatorDirectorEpoch });
}

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
        return appoint(input, state, command.targetPrincipalId, command.targetSessionId);
    }
    const { loss } = state;
    if (!loss || loss.directorEpoch !== command.expectedDirectorEpoch || nowEpochMs < loss.reconnectUntilEpochMs) {
        return { rejectionCode: 'group-mutation-rejected', message: 'The director appointment is still reserved.' };
    }
    if (command.operation === 'claim-player') {
        if (actorMember.role === 'spectator' || (state.deputyPrincipalId !== null && !loss.declined && nowEpochMs < loss.deputyUntilEpochMs)) {
            return { rejectionCode: 'group-mutation-rejected', message: 'The player has no current claim.' };
        }
        return appoint(input, state, actor.principalId, actor.sessionId);
    }
    if (loss.declined || actor.principalId !== state.deputyPrincipalId || nowEpochMs >= loss.deputyUntilEpochMs) {
        return { rejectionCode: 'group-mutation-rejected', message: 'The designated deputy has no current claim.' };
    }
    if (command.operation === 'decline-deputy') {
        return { metadata: storeRoomDirectorSuccession(metadata, { ...state, loss: { ...loss, declined: true } }) };
    }
    return appoint(input, state, actor.principalId, actor.sessionId);
}

function appoint({ snapshot, nowEpochMs }: DirectorChangeInput, state: RoomDirectorSuccession, principalId: string, sessionId: string): DirectorChange {
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

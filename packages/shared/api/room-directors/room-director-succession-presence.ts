import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch } from '../exact-object-decoding.ts';
import { readRallarGroupDirectorAppointment } from '../group-director.ts';
import { readRoomDirectorSuccession, storeRoomDirectorSuccession } from './room-director-succession-record.ts';
import type { GroupMember, GroupPresenceSession } from '../group-types.ts';

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

export function recoverRoomDirector(metadata: ApiJsonObject, { principalId, sessionId }: Pick<GroupPresenceSession, 'principalId' | 'sessionId'>, nowEpochMs: number): ApiJsonObject {
    requireEpoch(nowEpochMs, 'Director recovery time');
    const state = readRoomDirectorSuccession(metadata);
    const director = readRallarGroupDirectorAppointment(metadata);
    if (!state?.loss || !director || state.loss.directorEpoch !== director.epoch || director.sessionId !== sessionId ||
        director.principalId !== principalId || nowEpochMs < state.loss.lostAtEpochMs || nowEpochMs >= state.loss.reconnectUntilEpochMs) return metadata;
    return storeRoomDirectorSuccession(metadata, { ...state, loss: null });
}

/** Renewing an uninterrupted lease updates the durable loss anchor without publishing a new policy or succession revision. */
export function observeRoomDirectorPresence(
    metadata: ApiJsonObject, session: Pick<GroupPresenceSession, 'principalId' | 'sessionId' | 'expiresAtEpochMs'>, atEpochMs: number
): ApiJsonObject {
    const { principalId, sessionId, expiresAtEpochMs } = session;
    requireEpoch(atEpochMs, 'Presence observation time');
    requireEpoch(expiresAtEpochMs, 'Director lease end');
    const initial = readRoomDirectorSuccession(metadata);
    const director = readRallarGroupDirectorAppointment(metadata);
    if (!initial || director?.principalId !== principalId || director.sessionId !== sessionId) return metadata;
    const afterGap = settleDirectorLeaseLoss(metadata, atEpochMs);
    if (expiresAtEpochMs <= atEpochMs) return observeRoomDirectorLoss(afterGap, expiresAtEpochMs);
    const recovered = recoverRoomDirector(afterGap, session, atEpochMs);
    const state = readRoomDirectorSuccession(recovered)!;
    if (state.loss || state.directorLeaseExpiresAtEpochMs === expiresAtEpochMs) return recovered;
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

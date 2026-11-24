import type { IssuedAuthSession } from '../rallar-system/auth/persistence/auth-session-types.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { roomGuestCredentialExpiresAt, roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import { readRoomGuestCredential, ROOM_GUEST_TOKEN_PREFIX } from '../rallar-system/auth/credentials/room-guest-credential.ts';
import { authenticationRequired, authorizationDenied } from './request-auth-service.ts';

export interface RoomGuestRequest {
    readonly roomRef: GroupRef;
    readonly clientId: string;
    readonly sessionId: string;
}

/** A guest bearer is handled only at an explicitly room-scoped API entry. */
export async function readRoomGuestRequest(
    request: { header(name: string): string | undefined; },
    roomRef?: GroupRef
): Promise<RoomGuestRequest | undefined> {
    const header = request.header('authorization');
    if (!header?.startsWith('Bearer ' + ROOM_GUEST_TOKEN_PREFIX)) {
        return undefined;
    }
    const guest = await readRoomGuestCredential(header.slice('Bearer '.length));
    if (!guest || request.header('x-client-id') !== guest.clientId) {
        throw authenticationRequired('Invalid guest credential.');
    }
    if (roomRef && !isSameGroupRef(guest.roomRef, roomRef)) {
        throw authorizationDenied('Guest credential belongs to a different room.');
    }
    return guest;
}

export function assertRoomGuestSeat(guest: RoomGuestRequest, snapshot: GroupSnapshot, nowEpochMs: number): 'room' | 'finish-round' {
    const member = snapshot.members.find(candidate => candidate.principalId === guest.clientId);
    const mode = member && isSameGroupRef(snapshot.group, guest.roomRef) && isSameGroupRef(member, guest.roomRef)
        ? roomGuestAccessMode(snapshot.group, member, nowEpochMs)
        : 'expired';
    if (mode === 'expired') {
        throw authorizationDenied('Guest access to this room has ended.');
    }
    return mode;
}

export async function readRoomGuestSession(
    request: { header(name: string): string | undefined; },
    readSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>,
    nowEpochMs: () => number,
    roomRef?: GroupRef
): Promise<IssuedAuthSession | undefined> {
    const guest = await readRoomGuestRequest(request, roomRef);
    if (!guest) return undefined;
    const snapshot = await readSnapshot(guest.roomRef);
    if (!snapshot) throw authorizationDenied('Guest room is unavailable.');
    assertRoomGuestSeat(guest, snapshot, nowEpochMs());
    const member = snapshot.members.find(member => member.principalId === guest.clientId);
    if (!member?.guestLease) throw authorizationDenied('Guest membership is unavailable.');
    return {
        clientId: guest.clientId, sessionId: guest.sessionId, username: guest.clientId,
        accessToken: request.header('authorization')!.slice('Bearer '.length),
        issuedAtEpochMs: member.guestLease.admittedAtEpochMs, expiresAtEpochMs: roomGuestCredentialExpiresAt(snapshot.group, member)
    };
}

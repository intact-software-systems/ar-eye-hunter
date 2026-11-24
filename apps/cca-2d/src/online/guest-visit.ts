import { isGuestInvitationVerifier, isRoomGuestAccess, type RoomGuestAccess } from '@shared/api/room-guests/invitation.ts';

export type GuestVisit =
    | { room: string; nickname: string; access: RoomGuestAccess }
    | { room: string; nickname: string; invitationVerifier: string; guestSecret: string; requestId: string };

const storageKey = 'cca.guest-visit';

export function readGuestVisit(): GuestVisit | undefined {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) {
        return;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return;
    }
    if (typeof value !== 'object' || !value || !('nickname' in value) || typeof value.nickname !== 'string' ||
        !('room' in value) || typeof value.room !== 'string') {
        return;
    }
    const { room, nickname } = value;
    if ('access' in value && isRoomGuestAccess(value.access)) {
        return { room, nickname, access: value.access };
    }
    if ('invitationVerifier' in value && isGuestInvitationVerifier(value.invitationVerifier) &&
        'guestSecret' in value && isGuestInvitationVerifier(value.guestSecret) &&
        'requestId' in value && typeof value.requestId === 'string') {
        return { room, nickname, invitationVerifier: value.invitationVerifier, guestSecret: value.guestSecret, requestId: value.requestId };
    }
}

export function saveGuestVisit(visit: GuestVisit | undefined): void {
    if (visit) {
        sessionStorage.setItem(storageKey, JSON.stringify(visit));
    }
    else {
        sessionStorage.removeItem(storageKey);
    }
}

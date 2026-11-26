import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { isGuestInvitationVerifier, isRoomGuestAccess, type RoomGuestAccess } from '@shared/api/room-guests/invitation.ts';

export interface AdmittedGuestVisit {
    room: string;
    nickname: string;
    access: RoomGuestAccess;
    invitationSecret?: string;
}

export type GuestVisit =
    | AdmittedGuestVisit
    | { room: string; nickname: string; invitationVerifier: string; guestSecret: string; requestId: string };

const lastVisit = 'grumpy-town.last-guest-room';

function visitKey(room: string): string {
    return 'grumpy-town.guest-visit.' + encodeURIComponent(room);
}

export function readGuestVisit(roomId: string): GuestVisit | undefined {
    const raw = localStorage.getItem(visitKey(roomId));
    if (!raw) {
        return;
    }
    let value: ApiJsonValue;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return;
    }
    if (typeof value !== 'object' || !value || !('nickname' in value) || typeof value.nickname !== 'string' ||
        !('room' in value) || value.room !== roomId) {
        return;
    }
    const room = roomId;
    const { nickname } = value;
    if ('access' in value && isRoomGuestAccess(value.access)) {
        const invitationSecret = value.invitationSecret;
        return isGuestInvitationVerifier(invitationSecret) ? { room, nickname, access: value.access, invitationSecret } :
            { room, nickname, access: value.access };
    }
    if ('invitationVerifier' in value && isGuestInvitationVerifier(value.invitationVerifier) &&
        'guestSecret' in value && isGuestInvitationVerifier(value.guestSecret) &&
        'requestId' in value && typeof value.requestId === 'string') {
        return { room, nickname, invitationVerifier: value.invitationVerifier, guestSecret: value.guestSecret, requestId: value.requestId };
    }
}

export function saveGuestVisit(visit: GuestVisit): void {
    localStorage.setItem(visitKey(visit.room), JSON.stringify(visit));
    if ('access' in visit) localStorage.setItem(lastVisit, visit.room);
}

export function forgetGuestVisit(room: string): void {
    localStorage.removeItem(visitKey(room));
    if (localStorage.getItem(lastVisit) === room) localStorage.removeItem(lastVisit);
}

export function guestVisitUrl(room: string): URL {
    const url = new URL(import.meta.env.BASE_URL + 'guest', location.origin);
    url.searchParams.set('room', room);
    return url;
}

export function guestInvitationUrl(room: string, secret: string): URL {
    const url = new URL(import.meta.env.BASE_URL + 'guest', location.origin);
    url.hash = new URLSearchParams({ room, invite: secret }).toString();
    return url;
}

export function lastGuestVisitUrl(): URL | undefined {
    try {
        const room = localStorage.getItem(lastVisit);
        if (room && readGuestVisit(room)) return guestVisitUrl(room);
    } catch {
        // The solo landing page also runs with browser storage disabled.
    }
}

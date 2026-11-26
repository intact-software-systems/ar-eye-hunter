import { browserCredentialStore } from '@shared-web/browser/auth/browser-credential-store.ts';
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

export async function readGuestVisit(roomId: string): Promise<GuestVisit | undefined> {
    const raw = await browserCredentialStore.read(visitKey(roomId));
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

export async function saveGuestVisit(visit: GuestVisit): Promise<void> {
    await browserCredentialStore.write(visitKey(visit.room), JSON.stringify(visit));
    if ('access' in visit) await browserCredentialStore.write(lastVisit, visit.room);
}

export async function forgetGuestVisit(room: string): Promise<void> {
    await browserCredentialStore.remove(visitKey(room));
    await browserCredentialStore.removeIfEqual(lastVisit, room);
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

export async function lastGuestVisitUrl(): Promise<URL | undefined> {
    try {
        const room = await browserCredentialStore.read(lastVisit);
        if (room && await readGuestVisit(room)) return guestVisitUrl(room);
    } catch {
        // The solo landing page also runs with browser storage disabled.
    }
}

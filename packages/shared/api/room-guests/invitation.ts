export interface RoomGuestInvitation {
    readonly verifier: string;
    readonly expiresAtEpochMs: number;
}

export function toRoomGuestInvitation(verifier: string, issuedAtEpochMs: number): RoomGuestInvitation {
    return { verifier, expiresAtEpochMs: issuedAtEpochMs + 15 * 60_000 };
}

export function isGuestInvitationVerifier(value: unknown): value is string {
    return typeof value === 'string' && value.length === 64 && /^[0-9a-f]+$/.test(value);
}

export function validatedRoomGuestFields(group: object): readonly string[] {
    const fields: string[] = [];
    if ('temporaryPlayerRoom' in group) {
        if (group.temporaryPlayerRoom !== true || !('kind' in group) || group.kind !== 'room' ||
            !('expiresAtEpochMs' in group) || !Number.isSafeInteger(group.expiresAtEpochMs)) {
            throw new TypeError('Temporary player rooms require an absolute expiry.');
        }
        fields.push('temporaryPlayerRoom');
    }
    if ('guestInvitation' in group) {
        if (!isRoomGuestInvitation(group.guestInvitation)) throw new TypeError('Room guest invitation is invalid.');
        fields.push('guestInvitation');
    }
    return fields;
}

export function assertRoomGuestManager(member: object, temporaryPlayerRoom: boolean): void {
    if ('role' in member && member.role === 'owner' && ('guestLease' in member) !== temporaryPlayerRoom) {
        throw new TypeError('A temporary guest manager can only own its temporary player room.');
    }
}

export function isRoomGuestInvitation(value: unknown): value is RoomGuestInvitation {
    return typeof value === 'object' && value !== null &&
        'verifier' in value && isGuestInvitationVerifier(value.verifier) &&
        'expiresAtEpochMs' in value && typeof value.expiresAtEpochMs === 'number' &&
        Number.isSafeInteger(value.expiresAtEpochMs) && value.expiresAtEpochMs > 0 &&
        Object.keys(value).length === 2;
}

/** The invitation link carries the random secret. Only its verifier enters durable room state. */
export async function hashRoomInvitationSecret(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isRoomGuestDisplayName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
        value.trim() === value && Array.from(value).length <= 64 && !/[\p{Cc}\p{Cs}]/u.test(value);
}

export interface RoomGuestLease {
    readonly temporaryManager?: true;
    /** The court admission binds this seat to its own secret-derived transport session. */
    readonly courtSessionId?: string;
    readonly displayName?: string;
    readonly admittedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export const ROOM_GUEST_LIFETIME_MS = 4 * 60 * 60_000;

export function hasValidRoomGuestLease(member: object): boolean {
    if (!('role' in member) || !('guestLease' in member)) return false;
    const value = member.guestLease;
    return typeof value === 'object' && value !== null &&
        (('temporaryManager' in value && value.temporaryManager === true && member.role === 'owner') ||
            (!('temporaryManager' in value) && (member.role === 'member' || member.role === 'spectator'))) &&
        'admittedAtEpochMs' in value && typeof value.admittedAtEpochMs === 'number' &&
        Number.isSafeInteger(value.admittedAtEpochMs) && value.admittedAtEpochMs >= 0 &&
        'expiresAtEpochMs' in value && Number.isSafeInteger(value.expiresAtEpochMs) &&
        value.expiresAtEpochMs === value.admittedAtEpochMs + ROOM_GUEST_LIFETIME_MS &&
        (!('displayName' in value) || isRoomGuestDisplayName(value.displayName)) &&
        (!('courtSessionId' in value) || (member.role === 'member' && typeof value.courtSessionId === 'string' &&
            /^guest-session-[0-9a-f]{64}$/u.test(value.courtSessionId))) &&
        Object.keys(value).every(key => ['courtSessionId', 'temporaryManager', 'admittedAtEpochMs', 'expiresAtEpochMs', 'displayName'].includes(key));
}

/** Admission to one room, redeemable without issuing a registered-account session. */
export interface RoomGuestAccess {
    readonly clientId: string;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export function isRoomGuestAccess(value: unknown): value is RoomGuestAccess {
    return typeof value === 'object' && value !== null &&
        'clientId' in value && typeof value.clientId === 'string' && value.clientId.length > 0 &&
        'sessionId' in value && typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
        'accessToken' in value && typeof value.accessToken === 'string' && value.accessToken.length > 0 &&
        'issuedAtEpochMs' in value && typeof value.issuedAtEpochMs === 'number' &&
        Number.isSafeInteger(value.issuedAtEpochMs) && value.issuedAtEpochMs >= 0 &&
        'expiresAtEpochMs' in value && Number.isSafeInteger(value.expiresAtEpochMs) &&
        value.expiresAtEpochMs === value.issuedAtEpochMs + ROOM_GUEST_LIFETIME_MS;
}

export interface RoomGuestRedemption {
    readonly invitationSecret: string;
    readonly guestSecret: string;
    readonly displayName?: string;
}

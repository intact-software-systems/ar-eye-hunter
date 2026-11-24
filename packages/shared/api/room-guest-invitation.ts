export interface RoomGuestInvitation {
    readonly verifier: string;
    readonly expiresAtEpochMs: number;
}

export function isGuestInvitationVerifier(value: unknown): value is string {
    return typeof value === 'string' && value.length === 64 && /^[0-9a-f]+$/.test(value);
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

export interface RoomGuestLease {
    readonly admittedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export const ROOM_GUEST_LIFETIME_MS = 4 * 60 * 60_000;

export function isRoomGuestLease(value: unknown): value is RoomGuestLease {
    return typeof value === 'object' && value !== null &&
        'admittedAtEpochMs' in value && typeof value.admittedAtEpochMs === 'number' &&
        Number.isSafeInteger(value.admittedAtEpochMs) && value.admittedAtEpochMs >= 0 &&
        'expiresAtEpochMs' in value && Number.isSafeInteger(value.expiresAtEpochMs) &&
        value.expiresAtEpochMs === value.admittedAtEpochMs + ROOM_GUEST_LIFETIME_MS &&
        Object.keys(value).length === 2;
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

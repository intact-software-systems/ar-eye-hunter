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

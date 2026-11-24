import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';

export const ROOM_GUEST_TOKEN_PREFIX = 'guest.v1.';
const GUEST_SECRET = /^[0-9a-f]{64}$/u;

interface RoomGuestIdentity {
    readonly clientId: string;
    readonly sessionId: string;
}

interface RoomGuestCredential extends RoomGuestIdentity {
    readonly accessToken: string;
}

/** Reconstructs a browser's credential after a lost admission response, without storing its secret. */
export async function toRoomGuestCredential(ref: GroupRef, guestSecret: string): Promise<RoomGuestCredential> {
    if (!GUEST_SECRET.test(guestSecret) || guestSecret.length !== 64) {
        throw new TypeError('A guest secret must be 32 bytes encoded as lowercase hexadecimal.');
    }
    const roomRef = decodeExactGroupRef(ref, 'Guest');
    const payload = JSON.stringify([roomRef, guestSecret]);
    return {
        ...await deriveRoomGuestIdentity(payload),
        accessToken: ROOM_GUEST_TOKEN_PREFIX + toBase64Url(new TextEncoder().encode(payload))
    };
}

/** Identifies a candidate guest. Authorization still requires a current matching seat in the scoped room. */
export async function readRoomGuestCredential(token: string): Promise<(RoomGuestIdentity & { readonly roomRef: GroupRef; }) | undefined> {
    if (!token.startsWith(ROOM_GUEST_TOKEN_PREFIX)) {
        return undefined;
    }
    const bytes = decodeBase64Url(token.slice(ROOM_GUEST_TOKEN_PREFIX.length)).right;
    if (!bytes) {
        return undefined;
    }
    try {
        const fields: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!Array.isArray(fields) || fields.length !== 2 || typeof fields[1] !== 'string' || fields[1].length !== 64 || !GUEST_SECRET.test(fields[1])) {
            return undefined;
        }
        const roomRef = decodeExactGroupRef(fields[0], 'Guest');
        return { ...await deriveRoomGuestIdentity(JSON.stringify([roomRef, fields[1]])), roomRef };
    }
    catch (error) {
        if (error instanceof TypeError || error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}

async function deriveRoomGuestIdentity(payload: string): Promise<RoomGuestIdentity> {
    const clientId = 'guest-' + await guestDigest('principal', payload);
    return { clientId, sessionId: await roomGuestTransportSessionId(clientId) };
}

/** Session identity is public; opening the session still needs the secret-derived access token. */
export async function roomGuestTransportSessionId(principalId: string): Promise<string> {
    return 'guest-session-' + await guestDigest('session', principalId);
}

async function guestDigest(purpose: 'principal' | 'session', payload: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rallar:guest:v1:' + purpose + ':' + payload));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

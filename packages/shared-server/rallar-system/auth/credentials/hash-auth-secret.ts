import { toBase64Url } from '@shared/encoding/base64url.ts';

export async function hashAuthSecret(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return toBase64Url(new Uint8Array(digest));
}

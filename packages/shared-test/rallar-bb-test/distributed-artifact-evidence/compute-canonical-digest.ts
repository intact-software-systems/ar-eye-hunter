import { toBase64Url } from '@shared/encoding/base64url.ts';

/** The SHA-256 digest of canonical text, in unpadded base64url. */
export async function computeCanonicalDigest(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return toBase64Url(new Uint8Array(digest));
}

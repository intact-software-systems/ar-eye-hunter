export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
    return bytesToHex(new Uint8Array(signature));
}

export async function sha256CanonicalJson(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalJson(value)),
    );
    return bytesToHex(new Uint8Array(digest));
}

export async function constantTimeSecretEqual(
    left: string,
    right: string,
): Promise<boolean> {
    const [leftDigest, rightDigest] = await Promise.all([
        sha256CanonicalJson(left),
        sha256CanonicalJson(right),
    ]);
    return constantTimeHexEqual(leftDigest, rightDigest);
}

export function constantTimeHexEqual(left: string, right: string): boolean {
    const length = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < length; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Canonical JSON number must be finite');
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (!value || typeof value !== 'object') {
        throw new TypeError('Canonical JSON value is unsupported');
    }
    return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(',')}}`;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

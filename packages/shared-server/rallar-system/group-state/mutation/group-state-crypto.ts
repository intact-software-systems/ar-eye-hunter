export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
    return bytesToHex(new Uint8Array(signature));
}

export async function constantTimeSecretEqual(left: string, right: string): Promise<boolean> {
    const [leftDigest, rightDigest] = await Promise.all([sha256String(left), sha256String(right)]);
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

async function sha256String(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

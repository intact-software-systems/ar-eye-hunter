export type AuthCredentialIssuer = Readonly<{
    issueAccessToken(sessionId: string): Promise<string>;
    issueWebSocketTicket(requestId: string, sessionId: string): Promise<string>;
    issueAgentTicket(requestId: string, agentId: string, sessionId: string): Promise<string>;
}>;

export function createHmacAuthCredentialIssuer(secret: string): AuthCredentialIssuer {
    if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('RALLAR_AUTH_CREDENTIAL_SECRET must contain at least 32 characters');
    }
    return {
        issueAccessToken: async (sessionId) =>
            await signCredential(secret, 'access-token', [sessionId]),
        issueWebSocketTicket: async (requestId, sessionId) =>
            await signCredential(secret, 'ws-ticket', [requestId, sessionId]),
        issueAgentTicket: async (requestId, agentId, sessionId) =>
            await signCredential(secret, 'agent-ticket', [requestId, agentId, sessionId]),
    };
}

async function signCredential(
    secret: string,
    purpose: string,
    identity: readonly string[],
): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(JSON.stringify({
            domain: 'rallar-auth-credential-v1',
            purpose,
            identity,
        })),
    );
    return toBase64Url(new Uint8Array(signature));
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}

export const AUTH_SESSIONS_BY_TOKEN_NAMESPACE = 'auth-sessions:by-token';
export const AUTH_SESSIONS_BY_SESSION_NAMESPACE = 'auth-sessions:by-session';
export const WS_AUTH_TICKETS_NAMESPACE = 'auth-sessions:ws-tickets';
export const AGENT_SESSION_TICKETS_NAMESPACE = 'auth-sessions:agent-session-tickets';

export function authTokenDigestKey(accessTokenDigest: string): string {
    return keyPart('token-digest', accessTokenDigest);
}

export function authSessionKey(sessionId: string): string {
    return keyPart('session', sessionId);
}

export function authTicketDigestKey(ticketDigest: string): string {
    return keyPart('ticket-digest', ticketDigest);
}

function keyPart(name: string, value: string): string {
    return `${name}=${encodeURIComponent(value)}`;
}

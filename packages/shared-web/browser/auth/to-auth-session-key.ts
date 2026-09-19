import type { AuthSession } from '@shared/api/api-config.ts';

/** Canonical identity for one browser authentication and its delivery observations. */
export function toAuthSessionKey(session: Pick<AuthSession, 'clientId' | 'sessionId'>): string {
    return `${session.clientId}:${session.sessionId}`;
}

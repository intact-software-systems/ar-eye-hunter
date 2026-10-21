import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import type { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

/** Issues the WebSocket ticket an authorised connect consumes; the session must already be stored. */
export async function putAuthorisedWsTestTicket(
    sessions: Pick<AuthSessionRepository, 'putWebSocketTicket'>,
    session: Readonly<{ clientId: string; sessionId: string; expiresAtEpochMs: number; }>,
    ticket: string = `${session.sessionId}-ws-ticket`
): Promise<string> {
    await sessions.putWebSocketTicket({
        ticket,
        sessionId: session.sessionId,
        clientId: session.clientId,
        issuedAtEpochMs: Date.now() - 1,
        expiresAtEpochMs: Math.min(session.expiresAtEpochMs, Date.now() + 60_000)
    });
    return await hashAuthSecret(ticket);
}

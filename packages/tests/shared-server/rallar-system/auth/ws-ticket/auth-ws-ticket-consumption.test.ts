import { describe, expect, it } from 'vitest';

import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { authTicketDigestKey, WS_AUTH_TICKETS_NAMESPACE } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import {
    computeAuthWsTicketConsumption,
    readAuthWsTicketConsumption,
    validateAuthWsTicketConsumption,
    type AuthWsTicketConsumptionClaim
} from '@shared-server/rallar-system/auth/ws-ticket/auth-ws-ticket-consumption.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const NOW = Date.now();

interface TicketFixture {
    readonly sessions: AuthSessionRepository;
    readonly session: IssuedAuthSession;
    readonly claim: AuthWsTicketConsumptionClaim;
}

async function createTicketFixture(ticketExpiresAtEpochMs = NOW + 30_000): Promise<TicketFixture> {
    const sessions = new AuthSessionRepository(new FakeRuntimeStateRepository());
    const session: IssuedAuthSession = {
        clientId: 'player',
        username: 'player',
        sessionId: 'player-session',
        accessToken: 'player-token',
        issuedAtEpochMs: NOW - 1_000,
        expiresAtEpochMs: NOW + 60_000
    };
    await sessions.putSession(session);
    await sessions.putWebSocketTicket({
        ticket: 'raw-ticket',
        sessionId: session.sessionId,
        clientId: session.clientId,
        issuedAtEpochMs: NOW - 10,
        expiresAtEpochMs: ticketExpiresAtEpochMs
    });
    return {
        sessions,
        session,
        claim: {
            ticketDigest: await hashAuthSecret('raw-ticket'),
            clientId: session.clientId,
            sessionId: session.sessionId,
            sessionIssuedAtEpochMs: session.issuedAtEpochMs,
            sessionExpiresAtEpochMs: session.expiresAtEpochMs,
            capturedAtEpochMs: NOW
        }
    };
}

describe('WebSocket ticket consumption inside the authorised connect', () => {
    it('accepts a live ticket bound to the connecting session and deletes it by its read revision', async () => {
        const { sessions, claim } = await createTicketFixture();
        const read = await readAuthWsTicketConsumption(sessions, claim);

        expect(validateAuthWsTicketConsumption(claim, read)).toEqual([]);
        expect(computeAuthWsTicketConsumption(read)).toEqual({
            kind: 'delete',
            namespace: WS_AUTH_TICKETS_NAMESPACE,
            key: authTicketDigestKey(claim.ticketDigest),
            expectedRevision: read.ticket?.entry.revision
        });
    });

    it('rejects a consumed, unknown, expired or foreign ticket and a session the route did not read', async () => {
        const { sessions, session, claim } = await createTicketFixture();
        const read = await readAuthWsTicketConsumption(sessions, claim);

        expect(validateAuthWsTicketConsumption(claim, { ...read, ticket: null })).toEqual(['ticket-missing']);
        expect(validateAuthWsTicketConsumption({ ...claim, capturedAtEpochMs: NOW + 30_000 }, read)).toEqual([
            'ticket-expired'
        ]);
        expect(validateAuthWsTicketConsumption({ ...claim, sessionId: 'other-session' }, read)).toEqual([
            'ticket-session-differs',
            'session-differs'
        ]);
        expect(validateAuthWsTicketConsumption({ ...claim, sessionIssuedAtEpochMs: session.issuedAtEpochMs + 1 }, read))
            .toEqual(['session-differs']);
        expect(validateAuthWsTicketConsumption(claim, { ...read, session: null })).toEqual(['session-missing']);
        expect(validateAuthWsTicketConsumption({ ...claim, capturedAtEpochMs: NOW + 60_000 }, read)).toEqual([
            'ticket-expired',
            'session-expired'
        ]);
    });

    it('rejects a ticket whose session was replaced by a new access token', async () => {
        const { sessions, session, claim } = await createTicketFixture();
        await sessions.putSession({ ...session, accessToken: 'rotated-token' });

        expect(validateAuthWsTicketConsumption(claim, await readAuthWsTicketConsumption(sessions, claim))).toEqual([
            'session-differs'
        ]);
    });
});

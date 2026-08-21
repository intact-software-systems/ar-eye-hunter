import type { AuthSession } from '@shared/api/api-config.ts';

export type IssuedAuthSession =
    & AuthSession
    & Readonly<{
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;

export type IssuedWebSocketTicket = Readonly<{
    ticket: string;
    sessionId: string;
    clientId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type IssuedAgentSessionTicket =
    & IssuedWebSocketTicket
    & Readonly<{
        agentId: string;
    }>;

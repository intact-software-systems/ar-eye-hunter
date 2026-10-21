import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { AuthPersistenceOperation } from '../mutation/auth-mutation-contracts.ts';
import { writeAuthPersistenceOperation } from '../mutation/write-auth-mutation.ts';
import { WS_AUTH_TICKETS_NAMESPACE } from '../persistence/auth-storage-keys.ts';
import type { PersistedAuthSession } from '../persistence/persisted-auth-session.ts';
import type { PersistedWebSocketTicket } from '../persistence/persisted-auth-ticket.ts';

/** The ticket an upgrade presented and the session the route read for it, captured when the connect was enqueued. */
export interface AuthWsTicketConsumptionClaim {
    readonly ticketDigest: string;
    readonly clientId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly sessionExpiresAtEpochMs: number;
    readonly capturedAtEpochMs: number;
}

export interface AuthWsTicketConsumptionRead {
    readonly ticket: RuntimeStateEntryValue<PersistedWebSocketTicket> | null;
    readonly session: RuntimeStateEntryValue<PersistedAuthSession> | null;
}

export type AuthWsTicketConsumptionIssue =
    | 'ticket-missing'
    | 'ticket-expired'
    | 'ticket-session-differs'
    | 'session-missing'
    | 'session-differs'
    | 'session-expired';

export type AuthWsTicketConsumption = Extract<AuthPersistenceOperation, { kind: 'delete'; }>;

export function validateAuthWsTicketConsumption(
    claim: AuthWsTicketConsumptionClaim,
    read: AuthWsTicketConsumptionRead
): readonly AuthWsTicketConsumptionIssue[] {
    const ticket = read.ticket?.value;
    const session = read.session?.value;
    const issues: AuthWsTicketConsumptionIssue[] = [];
    if (ticket === undefined) {
        issues.push('ticket-missing');
    }
    else if (ticket.expiresAtEpochMs <= claim.capturedAtEpochMs) {
        issues.push('ticket-expired');
    }
    if (ticket !== undefined && (ticket.sessionId !== claim.sessionId || ticket.clientId !== claim.clientId)) {
        issues.push('ticket-session-differs');
    }
    if (session === undefined) {
        issues.push('session-missing');
        return issues;
    }
    if (
        session.sessionId !== claim.sessionId || session.clientId !== claim.clientId ||
        session.issuedAtEpochMs !== claim.sessionIssuedAtEpochMs ||
        session.expiresAtEpochMs !== claim.sessionExpiresAtEpochMs ||
        (ticket !== undefined && ticket.accessTokenDigest !== session.accessTokenDigest)
    ) {
        issues.push('session-differs');
    }
    if (session.expiresAtEpochMs <= claim.capturedAtEpochMs) {
        issues.push('session-expired');
    }
    return issues;
}

export function computeAuthWsTicketConsumption(read: AuthWsTicketConsumptionRead): AuthWsTicketConsumption {
    if (read.ticket === null) {
        throw new TypeError('WebSocket ticket consumption requires the read ticket');
    }
    return {
        kind: 'delete',
        namespace: WS_AUTH_TICKETS_NAMESPACE,
        key: read.ticket.entry.key,
        expectedRevision: read.ticket.entry.revision
    };
}

/** The connect's first guard: a ticket consumed or replaced since the read is a write conflict, never a second use. */
export async function writeAuthWsTicketConsumption(
    transaction: PSqlSql,
    consumption: AuthWsTicketConsumption
): Promise<void> {
    await writeAuthPersistenceOperation(transaction, consumption);
}

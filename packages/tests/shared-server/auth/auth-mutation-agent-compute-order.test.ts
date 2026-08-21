import { describe, expect, it } from 'vitest';

import type { IssueAuthAgentTicketsCommand } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';

describe('auth agent-ticket compute order', () => {
    it('preserves predecessor per-ticket session, persistence, and result conversion order', () => {
        const reads: string[] = [];
        const command = {
            version: 1,
            kind: 'issue-agent-tickets',
            requestId: 'agent-request',
            capturedAtEpochMs: 1_000,
            authority: session,
            tickets: [trackedAgentTicket('first', reads), trackedAgentTicket('second', reads)]
        } satisfies IssueAuthAgentTicketsCommand;

        computeAuthMutation({
            command,
            read: {
                kind: 'issue-agent-tickets',
                authority: emptySessionEntries,
                sessions: [emptySessionEntries, emptySessionEntries],
                tickets: [null, null],
                expiredTicketEntries: [null, null]
            },
            facts: { kind: command.kind },
            serviceId: 'auth-service'
        });

        expect(reads).toEqual([...ticketConversionReads('first'), ...ticketConversionReads('second')]);
    });
});

function trackedAgentTicket(
    label: string,
    reads: string[]
): IssueAuthAgentTicketsCommand['tickets'][number] {
    const ticket = {
        agentId: `${label}-agent`,
        sessionId: `${label}-session`,
        accessTokenDigest: `${label}-access-digest`,
        ticketDigest: `${label}-ticket-digest`,
        clientId: 'client-1',
        username: 'alice',
        issuedAtEpochMs: 1_000,
        sessionExpiresAtEpochMs: 2_000,
        ticketExpiresAtEpochMs: 1_500
    };
    return new Proxy(ticket, {
        get(target, property, receiver) {
            if (typeof property === 'string') {
                reads.push(`${label}:${property}`);
            }
            return Reflect.get(target, property, receiver);
        }
    });
}

function ticketConversionReads(label: string): readonly string[] {
    return [
        `${label}:clientId`,
        `${label}:username`,
        `${label}:sessionId`,
        `${label}:accessTokenDigest`,
        `${label}:issuedAtEpochMs`,
        `${label}:sessionExpiresAtEpochMs`,
        `${label}:ticketDigest`,
        `${label}:accessTokenDigest`,
        `${label}:sessionId`,
        `${label}:clientId`,
        `${label}:agentId`,
        `${label}:issuedAtEpochMs`,
        `${label}:ticketExpiresAtEpochMs`,
        `${label}:agentId`,
        `${label}:ticketDigest`,
        `${label}:sessionId`,
        `${label}:issuedAtEpochMs`,
        `${label}:ticketExpiresAtEpochMs`
    ];
}

const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessTokenDigest: 'access-token-digest',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000
} as const;

const emptySessionEntries = {
    byToken: null,
    bySession: null,
    expiredByTokenEntry: null,
    expiredBySessionEntry: null
} as const;

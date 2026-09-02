import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import {
    AGENT_SESSION_TICKETS_NAMESPACE,
    authTicketDigestKey,
    WS_AUTH_TICKETS_NAMESPACE
} from '../../persistence/auth-storage-keys.ts';
import {
    type PersistedAgentSessionTicket,
    type PersistedWebSocketTicket
} from '../../persistence/persisted-auth-ticket.ts';
import type { AuthComputedTicketWrite } from '../auth-mutation-contracts.ts';

export function computeAuthWebSocketTicketWrite(
    ticket: PersistedWebSocketTicket,
    expectedRevision: number | null
): AuthComputedTicketWrite {
    return computeAuthTicketWrite(
        WS_AUTH_TICKETS_NAMESPACE,
        ticket,
        expectedRevision
    );
}

export function computeAuthAgentTicketWrite(
    ticket: PersistedAgentSessionTicket,
    expectedRevision: number | null
): AuthComputedTicketWrite {
    return computeAuthTicketWrite(
        AGENT_SESSION_TICKETS_NAMESPACE,
        ticket,
        expectedRevision
    );
}

function computeAuthTicketWrite(
    namespace: AuthComputedTicketWrite['namespace'],
    ticket: PersistedWebSocketTicket | PersistedAgentSessionTicket,
    expectedRevision: number | null
): AuthComputedTicketWrite {
    return {
        namespace,
        storageKey: authTicketDigestKey(ticket.ticketDigest),
        serializedValue: encodeRuntimeStateJsonValue(ticket),
        expireAtIsoTimestamp: new Date(ticket.expiresAtEpochMs).toISOString(),
        expectedRevision
    };
}


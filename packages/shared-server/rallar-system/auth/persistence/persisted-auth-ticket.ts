import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    assertExactAuthPersistenceKeys,
    decodeAuthPersistenceObject,
    decodeAuthPersistenceString
} from './auth-persistence-value-decoding.ts';
import { decodeAuthPersistenceLifecycle } from './persisted-auth-session.ts';

export interface PersistedWebSocketTicket extends JsonWireObject {
    readonly ticketDigest: string;
    readonly accessTokenDigest: string;
    readonly sessionId: string;
    readonly clientId: string;
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export interface PersistedAgentSessionTicket extends PersistedWebSocketTicket {
    readonly agentId: string;
}

export function decodePersistedWebSocketTicket(
    input: JsonWireValue
): PersistedWebSocketTicket {
    const ticket = decodeAuthPersistenceObject(
        decodeJsonWireValue(input, 'Persisted websocket ticket'),
        'Persisted websocket ticket'
    );
    assertExactAuthPersistenceKeys(
        ticket,
        [
            'ticketDigest',
            'accessTokenDigest',
            'sessionId',
            'clientId',
            'issuedAtEpochMs',
            'expiresAtEpochMs'
        ],
        'Persisted websocket ticket'
    );
    return decodePersistedAuthTicket(ticket, 'Persisted websocket ticket');
}

export function decodePersistedAgentSessionTicket(
    input: JsonWireValue
): PersistedAgentSessionTicket {
    const ticket = decodeAuthPersistenceObject(
        decodeJsonWireValue(input, 'Persisted agent session ticket'),
        'Persisted agent session ticket'
    );
    assertExactAuthPersistenceKeys(
        ticket,
        [
            'ticketDigest',
            'accessTokenDigest',
            'sessionId',
            'clientId',
            'agentId',
            'issuedAtEpochMs',
            'expiresAtEpochMs'
        ],
        'Persisted agent session ticket'
    );
    const decoded = decodePersistedAuthTicket(ticket, 'Persisted agent session ticket');
    return {
        ...decoded,
        agentId: decodeAuthPersistenceString(
            ticket.agentId,
            'Persisted agent session ticket agentId'
        )
    };
}

function decodePersistedAuthTicket(
    ticket: JsonWireObject,
    label: string
): PersistedWebSocketTicket {
    const lifecycle = decodeAuthPersistenceLifecycle(ticket, label);
    return {
        ticketDigest: decodeAuthPersistenceString(ticket.ticketDigest, `${label} ticketDigest`),
        accessTokenDigest: decodeAuthPersistenceString(
            ticket.accessTokenDigest,
            `${label} accessTokenDigest`
        ),
        sessionId: decodeAuthPersistenceString(ticket.sessionId, `${label} sessionId`),
        clientId: decodeAuthPersistenceString(ticket.clientId, `${label} clientId`),
        issuedAtEpochMs: lifecycle.issuedAtEpochMs,
        expiresAtEpochMs: lifecycle.expiresAtEpochMs
    };
}

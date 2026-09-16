import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarServerRestResponse } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { sendRallarServerMutationRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { recordValue } from '../../shared/record-value.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';

export interface WebSocketTicketRequest {
    readonly apiBaseUrl: string;
    readonly authSession: AuthSession | undefined;
    readonly requestId: string;
    readonly timeoutMs: number;
}

/** Rejects with the request, response or ticket failure so the raw-socket action records it. */
export async function requestWebSocketTicket(input: WebSocketTicketRequest): Promise<AuthCommandCenterTicket> {
    const sent = await sendRallarServerMutationRequest({
        request: {
            apiBaseUrl: input.apiBaseUrl,
            method: 'POST',
            path: '/api/auth/ws-ticket',
            headersText: '{}',
            queryText: '{}',
            bodyText: '{}',
            responseBodyMode: 'json',
            attachAuth: true,
            authSession: input.authSession,
            timeoutMs: input.timeoutMs,
            forbidPlaceholderBaseUrl: false
        },
        requestId: input.requestId,
        fetch
    });
    return sent.flatMap((error) => Either.ofLeft<string, AuthCommandCenterTicket>(error), toWebSocketTicket).fold(
        (error) => Promise.reject(new Error(error)),
        (ticket) => Promise.resolve(ticket)
    );
}

function toWebSocketTicket(response: RallarServerRestResponse): Either<string, AuthCommandCenterTicket> {
    const body = recordValue(response.bodyJson);
    if (
        response.ok &&
        typeof body.ticket === 'string' &&
        typeof body.sessionId === 'string' &&
        typeof body.expiresAtEpochMs === 'number'
    ) {
        return Either.ofRight({
            ticket: body.ticket,
            sessionId: body.sessionId,
            expiresAtEpochMs: body.expiresAtEpochMs,
            issuedAtEpochMs: Date.now()
        });
    }
    return Either.ofLeft(response.error?.message ?? `WS ticket request returned ${response.status}`);
}

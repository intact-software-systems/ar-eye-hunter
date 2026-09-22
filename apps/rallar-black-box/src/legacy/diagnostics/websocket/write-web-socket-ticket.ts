import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarServerRestResponse } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { sendRallarServerMutationRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { recordValue } from '../../shared/record-value.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';

export interface WebSocketTicketWriteInput {
    readonly apiBaseUrl: string;
    readonly authSession: AuthSession | undefined;
    readonly requestId: string;
    readonly timeoutMs: number;
    nowMs(): number;
}

export async function writeWebSocketTicket(
    input: WebSocketTicketWriteInput
): Promise<Either<string, AuthCommandCenterTicket>> {
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
    return sent.flatMap(
        (error) => Either.ofLeft(error),
        (response) => toWebSocketTicket(response, input.nowMs())
    );
}

function toWebSocketTicket(
    response: RallarServerRestResponse,
    issuedAtEpochMs: number
): Either<string, AuthCommandCenterTicket> {
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
            issuedAtEpochMs
        });
    }
    return Either.ofLeft(response.error?.message ?? `WS ticket request returned ${response.status}`);
}

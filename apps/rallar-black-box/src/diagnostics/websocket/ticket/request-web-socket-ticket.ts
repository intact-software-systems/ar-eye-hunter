import type { AuthSession, WebSocketTicketResponse } from '@shared/api/api-config.ts';
import type { AuthCommandCenterTicket } from '../../../legacy/diagnostics/shared/auth-command-center-ticket.ts';
import { recordValue } from '../../../legacy/shared/record-value.ts';
import { executeRallarServerMutationRequest } from '../../../rallar-server-workbench.ts';

export interface RequestWebSocketTicketInput {
    readonly apiBaseUrl: string;
    readonly authSession?: AuthSession;
    readonly requestId: string;
    readonly timeoutMs: number;
}

export async function requestWebSocketTicket(
    input: RequestWebSocketTicketInput
): Promise<AuthCommandCenterTicket> {
    const response = await executeRallarServerMutationRequest(
        {
            apiBaseUrl: input.apiBaseUrl,
            method: 'POST',
            path: '/api/auth/ws-ticket',
            headersText: '{}',
            queryText: '{}',
            bodyText: '{}',
            responseBodyMode: 'json',
            attachAuth: true,
            authSession: input.authSession,
            timeoutMs: input.timeoutMs
        },
        input.requestId
    );
    const body = recordValue(response.bodyJson);
    if (
        response.ok &&
        typeof body.ticket === 'string' &&
        typeof body.sessionId === 'string' &&
        typeof body.expiresAtEpochMs === 'number'
    ) {
        const wsTicket: WebSocketTicketResponse = {
            ticket: body.ticket,
            sessionId: body.sessionId,
            expiresAtEpochMs: body.expiresAtEpochMs
        };
        return {
            ticket: wsTicket.ticket,
            sessionId: wsTicket.sessionId,
            expiresAtEpochMs: wsTicket.expiresAtEpochMs,
            issuedAtEpochMs: Date.now()
        };
    }

    throw new Error(response.error?.message ?? `WS ticket request returned ${response.status}`);
}

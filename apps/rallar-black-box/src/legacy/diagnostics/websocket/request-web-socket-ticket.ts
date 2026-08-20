import type { AuthSession, WebSocketTicketResponse } from '@shared/api/api-config.ts';
import { executeRallarServerMutationRequest } from '../../../rallar-server-workbench.ts';
import { recordValue } from '../../shared/record-value.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';

export async function requestWebSocketTicket(
  input: Readonly<{
    apiBaseUrl: string;
    authSession?: AuthSession;
    requestId: string;
    timeoutMs: number;
  }>,
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
      timeoutMs: input.timeoutMs,
    },
    input.requestId,
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
      expiresAtEpochMs: body.expiresAtEpochMs,
    };
    return {
      ticket: wsTicket.ticket,
      sessionId: wsTicket.sessionId,
      expiresAtEpochMs: wsTicket.expiresAtEpochMs,
      issuedAtEpochMs: Date.now(),
    };
  }

  throw new Error(response.error?.message ?? `WS ticket request returned ${response.status}`);
}

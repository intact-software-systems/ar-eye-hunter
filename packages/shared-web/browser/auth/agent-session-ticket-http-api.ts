import type {
    AgentSessionTicketRequest,
    AgentSessionTicketResponse,
    AuthSession,
    ConsumeAgentSessionTicketRequest
} from '@shared/api/api-config.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest, type ApiMutationRequestOptions } from '../api/send-api-http-request.ts';

export async function issueAgentSessionTickets(
    request: AgentSessionTicketRequest,
    options: ApiMutationRequestOptions
): Promise<AgentSessionTicketResponse> {
    return await issueAgentSessionTicketsAt(readApiBaseUrl(), request, options);
}

export async function issueAgentSessionTicketsAt(
    apiBaseUrl: string,
    request: AgentSessionTicketRequest,
    options: ApiMutationRequestOptions
): Promise<AgentSessionTicketResponse> {
    return await sendApiHttpRequest<AgentSessionTicketRequest, AgentSessionTicketResponse>({
        baseUrl: normalizeExplicitApiBaseUrl(apiBaseUrl),
        path: toApiMutationRequestPath('/api/auth/agent-session-tickets', options.requestId),
        method: 'POST',
        body: request,
        options
    });
}

export async function consumeAgentSessionTicket(
    request: ConsumeAgentSessionTicketRequest,
    options: ApiMutationRequestOptions
): Promise<AuthSession> {
    return await consumeAgentSessionTicketAt(readApiBaseUrl(), request, options);
}

export async function consumeAgentSessionTicketAt(
    apiBaseUrl: string,
    request: ConsumeAgentSessionTicketRequest,
    options: ApiMutationRequestOptions
): Promise<AuthSession> {
    return await sendApiHttpRequest<ConsumeAgentSessionTicketRequest, AuthSession>({
        baseUrl: normalizeExplicitApiBaseUrl(apiBaseUrl),
        path: toApiMutationRequestPath(
            '/api/auth/agent-session-tickets/consume',
            options.requestId
        ),
        method: 'POST',
        body: request,
        options
    });
}

function normalizeExplicitApiBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

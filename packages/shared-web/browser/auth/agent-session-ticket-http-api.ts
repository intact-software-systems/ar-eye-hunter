import type {
    AgentSessionTicketRequest,
    AgentSessionTicketResponse,
    ConsumeAgentSessionTicketRequest,
    ConsumeAgentSessionTicketResponse,
} from '@shared/api/api-config.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import {
    type ApiMutationRequestOptions,
    executeHttpRequest,
} from '../api/http-request.ts';

export async function issueAgentSessionTickets(
    request: AgentSessionTicketRequest,
    options: ApiMutationRequestOptions,
): Promise<AgentSessionTicketResponse> {
    return await issueAgentSessionTicketsAt(readApiBaseUrl(), request, options);
}

export async function issueAgentSessionTicketsAt(
    apiBaseUrl: string,
    request: AgentSessionTicketRequest,
    options: ApiMutationRequestOptions,
): Promise<AgentSessionTicketResponse> {
    return await executeHttpRequest<AgentSessionTicketRequest, AgentSessionTicketResponse>(
        normalizeExplicitApiBaseUrl(apiBaseUrl),
        toApiMutationRequestPath('/api/auth/agent-session-tickets', options.requestId),
        'POST',
        request,
        options,
    );
}

export async function consumeAgentSessionTicket(
    request: ConsumeAgentSessionTicketRequest,
    options: ApiMutationRequestOptions,
): Promise<ConsumeAgentSessionTicketResponse> {
    return await consumeAgentSessionTicketAt(readApiBaseUrl(), request, options);
}

export async function consumeAgentSessionTicketAt(
    apiBaseUrl: string,
    request: ConsumeAgentSessionTicketRequest,
    options: ApiMutationRequestOptions,
): Promise<ConsumeAgentSessionTicketResponse> {
    return await executeHttpRequest<
        ConsumeAgentSessionTicketRequest,
        ConsumeAgentSessionTicketResponse
    >(
        normalizeExplicitApiBaseUrl(apiBaseUrl),
        toApiMutationRequestPath(
            '/api/auth/agent-session-tickets/consume',
            options.requestId,
        ),
        'POST',
        request,
        options,
    );
}

function normalizeExplicitApiBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

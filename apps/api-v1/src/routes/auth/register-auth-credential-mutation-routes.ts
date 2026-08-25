import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type {
    AgentSessionTicketRequest,
    AgentSessionTicketResponse,
    ConsumeAgentSessionTicketRequest,
    ConsumeAgentSessionTicketResponse,
    LogoutResponse,
    WebSocketTicketResponse
} from '@shared/api/api-config.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';

import { readApiAuthCredentialProof, RequestAuthFailure } from '../../services/request-auth-service.ts';
import { toApiMutationFailureResponse, toApiMutationRateLimitResponse } from '../api-mutation-route-failure.ts';
import type { ConfigRouteDependencies } from '../config-route.ts';
import { readAuthMutationRequest, requireAuthMutationResult, toJsonResponse } from './auth-mutation-route-support.ts';

export function registerAuthCredentialMutationRoutes(
    app: Hono,
    dependencies: ConfigRouteDependencies
): void {
    registerLogoutRoute(app, dependencies);
    registerWebSocketTicketRoute(
        app,
        dependencies,
        new RateLimiterPolicy(
            dependencies.authentication.rateLimits.windowMs,
            dependencies.authentication.rateLimits.webSocketTicket
        )
    );
    registerAgentTicketIssueRoute(app, dependencies);
    registerAgentTicketConsumeRoute(app, dependencies);
}

function registerLogoutRoute(app: Hono, dependencies: ConfigRouteDependencies): void {
    app.post(
        '/api/auth/logout/requests/:requestId',
        (context) => logoutResponse(context, dependencies)
    );
}

async function logoutResponse(
    context: Context,
    dependencies: ConfigRouteDependencies
): Promise<Response> {
    try {
        const { requestId } = await readAuthMutationRequest(context);
        let authSession: IssuedAuthSession;
        try {
            authSession = await dependencies.requireApiAuthSession(context.req);
        }
        catch (authError) {
            if (authError instanceof RequestAuthFailure && authError.kind === 'authentication') {
                const proof = readApiAuthCredentialProof(context.req);
                if (proof) {
                    const replay = await dependencies.appAuthInbox
                        .replayLogoutSessionWithCredentialProof({ requestId, ...proof });
                    if (replay !== null) {
                        return toJsonResponse(
                            requireAuthMutationResult(replay) satisfies LogoutResponse
                        );
                    }
                }
            }
            throw authError;
        }
        return toJsonResponse(
            requireAuthMutationResult(
                await dependencies.appAuthInbox.logoutSession({
                    requestId,
                    session: authSession
                })
            ) satisfies LogoutResponse
        );
    }
    catch (error) {
        return toApiMutationFailureResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

function registerWebSocketTicketRoute(
    app: Hono,
    dependencies: ConfigRouteDependencies,
    rateLimit: RateLimiterPolicy
): void {
    app.post(
        '/api/auth/ws-ticket/requests/:requestId',
        (context) => webSocketTicketResponse(context, dependencies, rateLimit)
    );
}

async function webSocketTicketResponse(
    context: Context,
    dependencies: ConfigRouteDependencies,
    rateLimit: RateLimiterPolicy
): Promise<Response> {
    try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const { requestId } = await readAuthMutationRequest(context);
        return await RateLimiter.tryToExecuteOrDefault<Response>(
            readRateLimiter('auth-ws-ticket', authSession.sessionId, rateLimit),
            async () => {
                return toJsonResponse<WebSocketTicketResponse>(
                    requireAuthMutationResult(
                        await dependencies.appAuthInbox.issueWebSocketTicket({
                            requestId,
                            session: authSession,
                            ttlMs: dependencies.authentication.webSocketTicketTtlMs
                        })
                    )
                );
            },
            toApiMutationRateLimitResponse(
                context,
                'Too many websocket ticket requests',
                dependencies.authentication.rateLimits.windowMs
            )
        );
    }
    catch (error) {
        return toApiMutationFailureResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

function registerAgentTicketIssueRoute(
    app: Hono,
    dependencies: ConfigRouteDependencies
): void {
    app.post('/api/auth/agent-session-tickets/requests/:requestId', async (context) => {
        try {
            const authSession = await dependencies.requireApiAuthSession(context.req);
            const { requestId, body } = await readAuthMutationRequest(context);
            const request = body as AgentSessionTicketRequest;
            const agentIds = readAgentSessionTicketAgentIds(request);
            return toJsonResponse<AgentSessionTicketResponse>(
                requireAuthMutationResult(
                    await dependencies.appAuthInbox.issueAgentSessionTickets({
                        requestId,
                        session: authSession,
                        ticketTtlMs: dependencies.authentication.agentSessionTicketTtlMs,
                        agents: agentIds.map((agentId) => ({ agentId }))
                    })
                )
            );
        }
        catch (error) {
            return toApiMutationFailureResponse(
                context,
                error instanceof Error ? error : new Error(String(error))
            );
        }
    });
}

function registerAgentTicketConsumeRoute(
    app: Hono,
    dependencies: ConfigRouteDependencies
): void {
    app.post(
        '/api/auth/agent-session-tickets/consume/requests/:requestId',
        async (context) => {
            try {
                const { requestId, body } = await readAuthMutationRequest(context);
                const request = body as ConsumeAgentSessionTicketRequest;
                const ticket = typeof request.ticket === 'string' ? request.ticket.trim() : '';
                if (!ticket) {
                    throw new TypeError('Agent session ticket is required.');
                }
                return toJsonResponse(
                    requireAuthMutationResult(
                        await dependencies.appAuthInbox.consumeAgentSessionTicket({
                            requestId,
                            ticket
                        })
                    ) satisfies ConsumeAgentSessionTicketResponse
                );
            }
            catch (error) {
                return toApiMutationFailureResponse(
                    context,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    );
}

function readAgentSessionTicketAgentIds(
    request: AgentSessionTicketRequest
): readonly string[] {
    if (!Array.isArray(request.agentIds)) {
        throw new TypeError('agentIds must be a non-empty array');
    }
    const agentIds = request.agentIds
        .map((agentId) => typeof agentId === 'string' ? agentId.trim() : '')
        .filter((agentId) => agentId.length > 0);
    if (agentIds.length === 0) {
        throw new TypeError('agentIds must be a non-empty array');
    }
    if (agentIds.length > 6) {
        throw new TypeError('agentIds cannot contain more than 6 agents');
    }
    if (new Set(agentIds).size !== agentIds.length) {
        throw new TypeError('agentIds must be unique');
    }
    return agentIds;
}

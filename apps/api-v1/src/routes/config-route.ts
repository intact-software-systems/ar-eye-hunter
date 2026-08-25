import { signRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
import type { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { ApiConfig } from '@shared/api/api-config.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import type {
    ApiV1AuthenticationConfiguration,
    ApiV1OperatorTokenConfiguration
} from '../configuration/api-v1-configuration.ts';
import { toAuthErrorResponse } from '../services/request-auth-service.ts';
import { toJsonResponse } from './auth/auth-mutation-route-support.ts';
import { registerAuthCredentialMutationRoutes } from './auth/register-auth-credential-mutation-routes.ts';
import { registerAuthUserMutationRoutes } from './auth/register-auth-user-mutation-routes.ts';

export interface ConfigRouteDependencies {
    readonly requireApiAuthSession: (
        req: { header(name: string): string | undefined; }
    ) => Promise<IssuedAuthSession>;
    readonly now: () => number;
    readonly createTokenId: () => string;
    readonly appAuthInbox: Pick<
        AppAuthInboxService,
        | 'registerUser'
        | 'issueSession'
        | 'logoutSession'
        | 'replayLogoutSessionWithCredentialProof'
        | 'issueWebSocketTicket'
        | 'issueAgentSessionTickets'
        | 'consumeAgentSessionTicket'
    >;
    readonly authUserRepository: AuthUserRepository;
    readonly authentication: Pick<
        ApiV1AuthenticationConfiguration,
        | 'adminClientIds'
        | 'agentSessionTicketTtlMs'
        | 'rateLimits'
        | 'registrationMode'
        | 'sessionTtlMs'
        | 'staticClients'
        | 'webSocketTicketTtlMs'
    >;
    readonly operatorToken: ApiV1OperatorTokenConfiguration;
    readonly publicConfiguration: ApiConfig;
}

export function registerConfigRoutes(
    app: Hono,
    dependencies: ConfigRouteDependencies
): void {
    const deps = dependencies;

    app.get(
        '/api/config',
        (c) => c.json(dependencies.publicConfiguration)
    );

    registerAuthUserMutationRoutes(app, deps);
    registerAuthCredentialMutationRoutes(app, deps);

    app.post(
        '/api/black-box/control-token',
        (context) => issueBlackBoxControlTokenResponse(context, deps)
    );
}

async function issueBlackBoxControlTokenResponse(
    context: Context,
    dependencies: ConfigRouteDependencies
): Promise<Response> {
    try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const configuration = dependencies.operatorToken;
        if (configuration.mode === 'disabled') {
            return toJsonResponse(
                { error: 'Black-box operator token broker is not configured.' },
                503
            );
        }
        if (
            configuration.allowedClientIds.length > 0 &&
            !configuration.allowedClientIds.includes(authSession.clientId)
        ) {
            throw new Error(
                'Forbidden: black-box operator token is not allowed for this client'
            );
        }

        const ttlMs = configuration.ttlMs;
        const issuedAtEpochMs = dependencies.now();
        const expiresAtEpochMs = issuedAtEpochMs + ttlMs;
        const token = await signRallarBlackBoxOperatorToken({
            secret: configuration.secret,
            subject: authSession.username || authSession.clientId,
            sessionId: authSession.sessionId,
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: dependencies.createTokenId()
        });
        return toJsonResponse(
            {
                tokenType: 'Bearer',
                token,
                issuedAtEpochMs,
                expiresAtEpochMs,
                ttlMs
            } as const
        );
    }
    catch (error) {
        return toAuthRouteErrorResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

function toAuthRouteErrorResponse(
    context: Context,
    error: Error
): Response {
    const message = error.message;
    if (message.includes('already exists')) {
        return context.json({ error: message }, 409);
    }
    if (message.startsWith('Bad Request:')) {
        return context.json({ error: message }, 400);
    }
    if (message.startsWith('Forbidden:')) {
        return context.json({ error: message }, 403);
    }

    return toAuthErrorResponse(context, error);
}

import type { AuthSession } from '@shared/api/api-config.ts';
import type { AuthSessionRepository, IssuedAuthSession, } from '../repository/AuthSessionRepository.ts';
import { createAuthSessionRepository, createRuntimeStateRepository, } from '../repository/createStateRepositories.ts';

const BEARER_PREFIX = 'Bearer ';

export async function requireApiAuthSession(
    req: {
        header(name: string): string | undefined;
    },
    repository: AuthSessionRepository = createAuthSessionRepository(
        createRuntimeStateRepository(),
    ),
): Promise<IssuedAuthSession> {
    const accessToken = readBearerToken(req.header('authorization'));
    if (!accessToken) {
        throw unauthorized('Missing bearer token');
    }

    const clientId = req.header('x-client-id');
    if (!clientId) {
        throw unauthorized('Missing x-client-id header');
    }

    const session = await repository.findByAccessToken(accessToken);

    if (!session) {
        throw unauthorized('Invalid or expired access token');
    }

    if (session.clientId !== clientId) {
        throw unauthorized('Access token does not match x-client-id');
    }

    return session;
}

export async function requireWsAuthSession(
    input: {
        sessionId: string;
        ticket?: string;
    },
    repository: AuthSessionRepository = createAuthSessionRepository(
        createRuntimeStateRepository(),
    ),
): Promise<IssuedAuthSession> {
    if (!input.ticket) {
        throw unauthorized('Missing websocket auth ticket');
    }

    const session = await repository.consumeWebSocketTicket(input.ticket);

    if (!session) {
        throw unauthorized('Invalid or expired websocket auth ticket');
    }

    if (session.sessionId !== input.sessionId) {
        throw unauthorized('Websocket session id does not match auth ticket');
    }

    return session;
}

export function toAuthSession(session: IssuedAuthSession): AuthSession {
    return {
        clientId: session.clientId,
        accessToken: session.accessToken,
        username: session.username,
        sessionId: session.sessionId,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
}

export function toAuthErrorResponse(
    c: {
        json(value: unknown, status?: number): Response;
    },
    error: unknown,
): Response {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Unauthorized:') ? 401 : 400;
    return c.json({ error: message }, status);
}

function readBearerToken(authorization?: string): string | undefined {
    if (!authorization?.startsWith(BEARER_PREFIX)) {
        return undefined;
    }

    const token = authorization.slice(BEARER_PREFIX.length).trim();
    return token.length > 0 ? token : undefined;
}

function unauthorized(message: string): Error {
    return new Error(`Unauthorized: ${message}`);
}

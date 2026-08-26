import { type AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { type AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

const BEARER_PREFIX = 'Bearer ';

export interface ApiAuthCredentialProof {
    readonly accessToken: string;
    readonly clientId: string;
}

export type RequestAuthFailureKind = 'authentication' | 'authorization';

export interface RequestAuthErrorResponse {
    readonly error: string;
}

export class RequestAuthFailure extends Error {
    readonly kind: RequestAuthFailureKind;
    readonly code: string;
    readonly status: 401 | 403;
    readonly details: Readonly<Record<string, boolean | null | number | string>> | null;

    constructor(
        input: Readonly<{
            kind: RequestAuthFailureKind;
            code: string;
            status: 401 | 403;
            message: string;
            details?: Readonly<Record<string, boolean | null | number | string>> | null;
        }>
    ) {
        super(input.message);
        this.kind = input.kind;
        this.code = input.code;
        this.status = input.status;
        this.details = input.details ?? null;
        this.name = 'RequestAuthFailure';
    }
}

export function authenticationRequired(
    message: string,
    code = 'authentication-required'
): RequestAuthFailure {
    return new RequestAuthFailure({ kind: 'authentication', code, status: 401, message });
}

export function authorizationDenied(
    message: string,
    code = 'authorization-denied'
): RequestAuthFailure {
    return new RequestAuthFailure({ kind: 'authorization', code, status: 403, message });
}

export function readApiAuthCredentialProof(request: {
    header(name: string): string | undefined;
}): ApiAuthCredentialProof | undefined {
    const accessToken = readBearerToken(request.header('authorization'));
    const clientId = request.header('x-client-id');
    return accessToken && clientId ? { accessToken, clientId } : undefined;
}

export async function requireApiAuthSession(
    request: {
        header(name: string): string | undefined;
    },
    repository: AuthSessionRepository
): Promise<IssuedAuthSession> {
    const accessToken = readBearerToken(request.header('authorization'));
    if (!accessToken) {
        throw unauthorized('Missing bearer token');
    }
    const clientId = request.header('x-client-id');
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
    appAuthInbox: Pick<AppAuthInboxService, 'consumeWebSocketTicket'>,
    facts: Readonly<{ requestId: string; }>
): Promise<IssuedAuthSession> {
    if (!input.ticket) {
        throw unauthorized('Missing websocket auth ticket');
    }

    const consumed = await appAuthInbox.consumeWebSocketTicket({
        ...facts,
        ticket: input.ticket,
        expectedSessionId: input.sessionId
    });
    if (consumed.left !== undefined || consumed.right === undefined) {
        throw unauthorized('Invalid or expired websocket auth ticket');
    }
    return consumed.right;
}

export function toAuthSession(session: IssuedAuthSession): AuthSession {
    return {
        clientId: session.clientId,
        accessToken: session.accessToken,
        username: session.username,
        sessionId: session.sessionId,
        expiresAtEpochMs: session.expiresAtEpochMs
    };
}

export function toAuthErrorResponse(
    context: {
        json(value: RequestAuthErrorResponse, status?: number): Response;
    },
    error: unknown
): Response {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof RequestAuthFailure
        ? error.status
        : 400;
    return context.json({ error: message }, status);
}

function readBearerToken(authorization?: string): string | undefined {
    if (!authorization?.startsWith(BEARER_PREFIX)) {
        return undefined;
    }

    const token = authorization.slice(BEARER_PREFIX.length).trim();
    return token.length > 0 ? token : undefined;
}

function unauthorized(message: string): RequestAuthFailure {
    return authenticationRequired(`Unauthorized: ${message}`);
}

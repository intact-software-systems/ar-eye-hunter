import type {
    AuthSessionRepository,
    IssuedAuthSession
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { AppAuthInboxService } from '../rallar-system/services/AppAuthInboxService.ts';

const BEARER_PREFIX = 'Bearer ';

export interface ApiAuthCredentialProof {
    readonly accessToken: string;
    readonly clientId: string;
}

export type RequestAuthFailureKind = 'authentication' | 'authorization';

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

export function readApiAuthCredentialProof(req: {
    header(name: string): string | undefined;
}): ApiAuthCredentialProof | undefined {
    const accessToken = readBearerToken(req.header('authorization'));
    const clientId = req.header('x-client-id');
    return accessToken && clientId ? { accessToken, clientId } : undefined;
}

export async function requireApiAuthSession(
    req: {
        header(name: string): string | undefined;
    },
    repository: AuthSessionRepository
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
    c: {
        json(value: unknown, status?: number): Response;
    },
    error: unknown
): Response {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof RequestAuthFailure
        ? error.status
        : readExplicitAuthErrorStatus(typeof error === 'object' ? error : null) ?? 400;
    return c.json({ error: message }, status);
}

const AUTH_ERROR_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 429, 503];

function readExplicitAuthErrorStatus(error: object | null): number | undefined {
    if (!error || !('status' in error)) {
        return undefined;
    }
    const status = Number((error as { status?: number | string; }).status);
    return AUTH_ERROR_STATUSES.includes(status) ? status : undefined;
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

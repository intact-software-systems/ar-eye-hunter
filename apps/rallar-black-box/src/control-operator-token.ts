import type { AuthSession } from '@shared/api/api-config.ts';

export type BlackBoxControlTokenSession = Readonly<{
    source: 'brokered';
    token: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
    ttlMs: number;
}>;

export type ResolvedBlackBoxControlToken =
    | Readonly<{ source: 'manual'; token: string }>
    | Readonly<{ source: 'brokered'; token: string; session: BlackBoxControlTokenSession }>;

export type BlackBoxControlTokenFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export const BLACK_BOX_CONTROL_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

export function shouldRefreshBlackBoxControlToken(
    session: BlackBoxControlTokenSession | undefined,
    nowEpochMs = Date.now(),
    refreshSkewMs = BLACK_BOX_CONTROL_TOKEN_REFRESH_SKEW_MS,
): boolean {
    return !session || session.expiresAtEpochMs - nowEpochMs <= refreshSkewMs;
}

export async function resolveBlackBoxControlToken(input: Readonly<{
    manualToken?: string;
    brokeredToken?: BlackBoxControlTokenSession;
    apiBaseUrl: string;
    authSession?: AuthSession;
    fetchFn?: BlackBoxControlTokenFetch;
    nowEpochMs?: number;
    refreshSkewMs?: number;
}>): Promise<ResolvedBlackBoxControlToken> {
    const manualToken = input.manualToken?.trim();
    if (manualToken) {
        return {
            source: 'manual',
            token: manualToken,
        };
    }

    if (!input.authSession) {
        throw new Error(
            'Sign in or enter a Control Token to run recipes on connected agents.',
        );
    }

    if (
        !shouldRefreshBlackBoxControlToken(
            input.brokeredToken,
            input.nowEpochMs,
            input.refreshSkewMs,
        ) &&
        input.brokeredToken
    ) {
        return {
            source: 'brokered',
            token: input.brokeredToken.token,
            session: input.brokeredToken,
        };
    }

    const session = await fetchBlackBoxControlToken({
        apiBaseUrl: input.apiBaseUrl,
        authSession: input.authSession,
        fetchFn: input.fetchFn,
    });
    return {
        source: 'brokered',
        token: session.token,
        session,
    };
}

export async function fetchBlackBoxControlToken(input: Readonly<{
    apiBaseUrl: string;
    authSession: AuthSession;
    fetchFn?: BlackBoxControlTokenFetch;
}>): Promise<BlackBoxControlTokenSession> {
    const response = await (input.fetchFn ?? fetch)(
        blackBoxControlTokenUrl(input.apiBaseUrl),
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${input.authSession.accessToken}`,
                'x-client-id': input.authSession.clientId,
            },
        },
    );

    if (!response.ok) {
        throw new Error(await blackBoxControlTokenErrorMessage(response));
    }

    const payload = await response.json() as {
        tokenType?: unknown;
        token?: unknown;
        issuedAtEpochMs?: unknown;
        expiresAtEpochMs?: unknown;
        ttlMs?: unknown;
    };

    if (
        payload.tokenType !== 'Bearer' ||
        typeof payload.token !== 'string' ||
        payload.token.trim().length === 0 ||
        typeof payload.issuedAtEpochMs !== 'number' ||
        typeof payload.expiresAtEpochMs !== 'number' ||
        typeof payload.ttlMs !== 'number'
    ) {
        throw new Error('Black-box control token broker returned an invalid response.');
    }

    return {
        source: 'brokered',
        token: payload.token,
        issuedAtEpochMs: payload.issuedAtEpochMs,
        expiresAtEpochMs: payload.expiresAtEpochMs,
        ttlMs: payload.ttlMs,
    };
}

function blackBoxControlTokenUrl(apiBaseUrl: string): string {
    const baseUrl = apiBaseUrl.trim() || globalThis.location?.origin || 'http://localhost:8080';
    return new URL('/api/black-box/control-token', baseUrl).toString();
}

async function blackBoxControlTokenErrorMessage(response: Response): Promise<string> {
    const fallback = `Black-box control token request failed with HTTP ${response.status}.`;
    try {
        const payload = await response.json() as { error?: unknown };
        return typeof payload.error === 'string' && payload.error.trim().length > 0
            ? payload.error
            : fallback;
    } catch (_error) {
        return fallback;
    }
}

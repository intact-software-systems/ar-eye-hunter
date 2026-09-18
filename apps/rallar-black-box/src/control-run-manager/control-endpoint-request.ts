export type ControlRunManagerFetch = (
    input: RequestInfo | URL,
    /** Absent for a plain GET, as in the `fetch` signature this stands in for. */
    init?: RequestInit
) => Promise<Response>;

/**
 * What every control-server reader needs to address one endpoint. `token` is `undefined` when the
 * caller addresses the endpoint anonymously, so no `Authorization` header is sent;
 * `createDefaultControlEndpointRequest` is the composition root that names the browser's own
 * `fetch` for callers that do not supply one.
 */
export type ControlEndpointRequest = Readonly<{
    baseUrl: string;
    token: string | undefined;
    fetchFn: ControlRunManagerFetch;
}>;

/** Addresses one run by id. */
export type ControlRunRequest = ControlEndpointRequest & Readonly<{ runId: string; }>;

/** Addresses one distributed run by id. */
export type ControlDistributedRunRequest =
    & ControlEndpointRequest
    & Readonly<{ distributedRunId: string; }>;

const DEFAULT_CONTROL_HTTP_BASE_URL = 'http://localhost:5180';
const CONTROL_PATH_SUFFIX = '/control';

export function createDefaultControlEndpointRequest(
    input: Readonly<{ baseUrl: string; token: string | undefined; }>
): ControlEndpointRequest {
    return {
        baseUrl: input.baseUrl,
        token: input.token,
        fetchFn: (request, init) => fetch(request, init)
    };
}

export function toControlHttpBaseUrl(value: string | undefined): string {
    if (!value) {
        return DEFAULT_CONTROL_HTTP_BASE_URL;
    }

    try {
        const url = new URL(value);
        if (url.protocol === 'ws:') {
            url.protocol = 'http:';
        }
        else if (url.protocol === 'wss:') {
            url.protocol = 'https:';
        }
        if (url.pathname.endsWith(CONTROL_PATH_SUFFIX)) {
            url.pathname = url.pathname.slice(0, -CONTROL_PATH_SUFFIX.length) || '/';
        }
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    }
    catch (_error) {
        return DEFAULT_CONTROL_HTTP_BASE_URL;
    }
}

export function toNormalizedBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_CONTROL_HTTP_BASE_URL;
}

export function toAuthorizationHeaders(token: string | undefined): Record<string, string> {
    return token && token.trim().length > 0
        ? {
            Authorization: `Bearer ${token.trim()}`
        }
        : {};
}

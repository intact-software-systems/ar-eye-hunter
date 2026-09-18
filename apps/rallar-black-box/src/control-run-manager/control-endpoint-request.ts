export type ControlRunManagerFetch = (
    input: RequestInfo | URL,
    /** Absent for a plain GET, as in the `fetch` signature this stands in for. */
    init?: RequestInit
) => Promise<Response>;

/** What every control-server reader needs to address one endpoint. */
export type ControlEndpointRequest = Readonly<{
    baseUrl: string;
    /** Absent when the endpoint is called anonymously, so no `Authorization` header is sent. */
    token?: string;
    /** Absent when the caller accepts the browser's own `fetch` instead of supplying one. */
    fetchFn?: ControlRunManagerFetch;
}>;

/** Addresses one run by id. */
export type ControlRunRequest = ControlEndpointRequest & Readonly<{ runId: string; }>;

/** Addresses one distributed run by id. */
export type ControlDistributedRunRequest =
    & ControlEndpointRequest
    & Readonly<{ distributedRunId: string; }>;

const DEFAULT_CONTROL_HTTP_BASE_URL = 'http://localhost:5180';
const CONTROL_PATH_SUFFIX = '/control';

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

import { ControlRunManagerHttpError } from '../../control-http-error.ts';

export type ControlRetentionRequestFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

type ControlRetentionRequestInput = Readonly<{
    baseUrl: string;
    fetchFn: ControlRetentionRequestFetch;
}>;

export function requestControlRetentionPreview(
    input: ControlRetentionRequestInput,
): Promise<unknown> {
    const url = retentionCleanupUrl(input.baseUrl);
    url.searchParams.set('dryRun', 'true');
    return requestRetention(input.fetchFn, url);
}

export function requestControlRetentionConfirmation(
    input: ControlRetentionRequestInput & Readonly<{ planToken: string }>,
): Promise<unknown> {
    const url = retentionCleanupUrl(input.baseUrl);
    url.searchParams.set('planToken', input.planToken);
    return requestRetention(input.fetchFn, url);
}

export function requestLegacyControlRetentionCleanup(
    input: ControlRetentionRequestInput,
): Promise<unknown> {
    return requestRetention(input.fetchFn, retentionCleanupUrl(input.baseUrl));
}

function retentionCleanupUrl(baseUrl: string): URL {
    return new URL('/retention/cleanup', new URL(baseUrl));
}

async function requestRetention(
    fetchFn: ControlRetentionRequestFetch,
    url: URL,
): Promise<unknown> {
    const response = await fetchFn(url, { method: 'POST' });
    return readJsonResponse(response);
}

async function readJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let value: unknown = {};
    let parseError: unknown;
    if (text.length > 0) {
        try {
            value = JSON.parse(text);
        } catch (error) {
            parseError = error;
        }
    }
    if (!response.ok) {
        const message = value && typeof value === 'object' && 'error' in value
            ? String((value as { error: unknown }).error)
            : `Control server request failed: ${response.status} ${response.statusText}`;
        throw new ControlRunManagerHttpError(
            message,
            response.status,
            response.statusText,
        );
    }
    if (parseError) throw parseError;
    return value;
}

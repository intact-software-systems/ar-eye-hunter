import { Either } from '@shared/resilience/Either.ts';
import {
    createControlHttpFailure,
    type ControlRequestFailure
} from '../../control-run-manager/control-request-failure.ts';

export type ControlRetentionRequestFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
) => Promise<Response>;

type ControlRetentionRequestInput = Readonly<{
    baseUrl: string;
    fetchFn: ControlRetentionRequestFetch;
}>;

export function requestControlRetentionPreview(
    input: ControlRetentionRequestInput
): Promise<Either<ControlRequestFailure, unknown>> {
    const url = retentionCleanupUrl(input.baseUrl);
    url.searchParams.set('dryRun', 'true');
    return requestRetention(input.fetchFn, url);
}

export function requestControlRetentionConfirmation(
    input: ControlRetentionRequestInput & Readonly<{ planToken: string; }>
): Promise<Either<ControlRequestFailure, unknown>> {
    const url = retentionCleanupUrl(input.baseUrl);
    url.searchParams.set('planToken', input.planToken);
    return requestRetention(input.fetchFn, url);
}

export function requestLegacyControlRetentionCleanup(
    input: ControlRetentionRequestInput
): Promise<Either<ControlRequestFailure, unknown>> {
    return requestRetention(input.fetchFn, retentionCleanupUrl(input.baseUrl));
}

function retentionCleanupUrl(baseUrl: string): URL {
    return new URL('/retention/cleanup', new URL(baseUrl));
}

async function requestRetention(
    fetchFn: ControlRetentionRequestFetch,
    url: URL
): Promise<Either<ControlRequestFailure, unknown>> {
    const response = await fetchFn(url, { method: 'POST' });
    return readJsonResponse(response);
}

async function readJsonResponse(
    response: Response
): Promise<Either<ControlRequestFailure, unknown>> {
    const text = await response.text();
    if (!response.ok) {
        return Either.ofLeft(
            createControlHttpFailure(response, decodeFailureMessage(text, response))
        );
    }
    // A 2xx body the control server could not have meant throws here: the transport reads that as
    // a reachable protocol error rather than as a retention outcome.
    return Either.ofRight(text.length === 0 ? {} : JSON.parse(text));
}

function decodeFailureMessage(text: string, response: Response): string {
    const requestFailed = `Control server request failed: ${response.status} ${response.statusText}`;
    if (text.length === 0) {
        return requestFailed;
    }
    let body: unknown;
    try {
        body = JSON.parse(text);
    }
    catch {
        return requestFailed;
    }
    return body && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : requestFailed;
}

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
    let value: unknown = {};
    let parseError: unknown;
    if (text.length > 0) {
        try {
            value = JSON.parse(text);
        }
        catch (error) {
            parseError = error;
        }
    }
    if (!response.ok) {
        return Either.ofLeft(createControlHttpFailure(response, failureMessage(value, response)));
    }
    if (parseError) {
        // A 2xx body the control server could not have meant: the transport reads this as a
        // reachable protocol error rather than as a retention outcome.
        throw parseError;
    }
    return Either.ofRight(value);
}

function failureMessage(value: unknown, response: Response): string {
    return value && typeof value === 'object' && 'error' in value
        ? String((value as { error: unknown; }).error)
        : `Control server request failed: ${response.status} ${response.statusText}`;
}

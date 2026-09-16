import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { Either } from '@shared/resilience/Either.ts';
import type {
    RallarServerResponseBodyMode,
    RallarServerRestError,
    RallarServerRestErrorKind,
    RallarServerRestRequest,
    RallarServerRestRequestInput,
    RallarServerRestResponse
} from './rallar-server-workbench-contracts.ts';
import { toRallarServerRestRequest } from './to-rallar-server-rest-request.ts';

export interface SendRallarServerRestRequestInput {
    readonly request: RallarServerRestRequestInput;
    readonly fetch: typeof fetch;
}

export interface SendRallarServerMutationRequestInput extends SendRallarServerRestRequestInput {
    readonly requestId: string;
}

interface ReadRallarServerResponseInput {
    readonly input: RallarServerRestRequestInput;
    readonly request: RallarServerRestRequest;
    readonly fetchResource: typeof fetch;
}

interface ReceivedRallarServerResponse {
    readonly response: Response;
    readonly request: RallarServerRestRequest;
    readonly responseBodyMode: RallarServerResponseBodyMode;
    readonly durationMs: number;
}

/** A request whose fields cannot be translated is not sent; transport, status and body failures come back as responses. */
export async function sendRallarServerRestRequest(
    { request: input, fetch: fetchResource }: SendRallarServerRestRequestInput
): Promise<Either<string, RallarServerRestResponse>> {
    return await toRallarServerRestRequest(input).fold(
        async (error) => Either.ofLeft<string, RallarServerRestResponse>(error),
        async (request) =>
            Either.ofRight<string, RallarServerRestResponse>(
                await readRallarServerResponse({ input, request, fetchResource })
            )
    );
}

export async function sendRallarServerMutationRequest(
    { request, requestId, fetch: fetchResource }: SendRallarServerMutationRequestInput
): Promise<Either<string, RallarServerRestResponse>> {
    return await toBodyTextWithoutRequestId(request.bodyText).fold(
        async (error) => Either.ofLeft<string, RallarServerRestResponse>(error),
        async (bodyText) =>
            await sendRallarServerRestRequest({
                request: { ...request, path: toApiMutationRequestPath(request.path, requestId), bodyText },
                fetch: fetchResource
            })
    );
}

async function readRallarServerResponse(
    { input, request, fetchResource }: ReadRallarServerResponseInput
): Promise<RallarServerRestResponse> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? setTimeout(() => controller.abort(), input.timeoutMs)
        : undefined;
    try {
        const response = await fetchResource(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.bodyText,
            signal: controller.signal
        });
        const durationMs = Date.now() - startedAt;
        return await readReceivedResponse({ response, request, responseBodyMode: input.responseBodyMode, durationMs });
    }
    catch (error) {
        return {
            ok: false,
            url: request.url,
            status: 0,
            statusText: 'Fetch failed',
            durationMs: Date.now() - startedAt,
            headers: {},
            bodyText: '',
            bodyKind: 'empty',
            error: decodeFetchError(error)
        };
    }
    finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

async function readReceivedResponse(
    { response, request, responseBodyMode, durationMs }: ReceivedRallarServerResponse
): Promise<RallarServerRestResponse> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    const bodyText = responseBodyMode === 'none' ? '' : await response.text();
    const body = toResponseBody(bodyText, headers, responseBodyMode);
    const error = body.error ??
        (response.ok
            ? undefined
            : { kind: toHttpErrorKind(response.status), message: `HTTP ${response.status} ${response.statusText}` });
    return {
        ok: response.ok && !error,
        url: response.url || request.url,
        status: response.status,
        statusText: response.statusText,
        durationMs,
        headers,
        bodyText,
        bodyJson: body.bodyJson,
        bodyKind: body.bodyKind,
        error
    };
}

function toResponseBody(
    bodyText: string,
    headers: Readonly<Record<string, string>>,
    mode: RallarServerResponseBodyMode
): Pick<RallarServerRestResponse, 'bodyKind' | 'bodyJson' | 'error'> {
    if (!bodyText) {
        return { bodyKind: 'empty' };
    }
    const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
    if (mode !== 'json' && !(mode === 'auto' && contentType.includes('json'))) {
        return { bodyKind: 'text' };
    }
    try {
        return { bodyKind: 'json', bodyJson: JSON.parse(bodyText) };
    }
    catch (error) {
        return {
            bodyKind: 'text',
            error: {
                kind: 'invalid-json',
                message: `Response JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
            }
        };
    }
}

function toHttpErrorKind(status: number): RallarServerRestErrorKind {
    if (status === 401) {
        return 'unauthenticated';
    }
    return status === 403 ? 'forbidden' : 'http-error';
}

function decodeFetchError(error: unknown): RallarServerRestError {
    if (error instanceof DOMException && error.name === 'AbortError') {
        return { kind: 'timeout', message: 'Rallar Server request timed out.' };
    }
    return { kind: 'network-or-cors', message: error instanceof Error ? error.message : String(error) };
}

function toBodyTextWithoutRequestId(bodyText: string): Either<string, string> {
    const trimmed = bodyText.trim();
    if (!trimmed) {
        return Either.ofRight(bodyText);
    }
    try {
        const body = JSON.parse(trimmed);
        return Either.ofRight(
            isJsonRecordValue(body)
                ? JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId')))
                : bodyText
        );
    }
    catch (error) {
        return Either.ofLeft(`Body is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
}

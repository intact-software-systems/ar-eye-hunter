import { decodeALTraceId, newALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';

import { ApiHttpError, type ApiHttpMethod } from './http-error.ts';

export interface ApiRequestOptions {
    readonly signal?: AbortSignal;
    readonly authSession?: AuthSession | null;
    /** An earlier operation's trace sent as `x-request-id`, as `RallarMessageSendBase.traceId`; absent, a new trace. */
    readonly traceId?: string;
}

export interface ApiMutationRequestOptions extends ApiRequestOptions {
    readonly requestId: string;
}

export interface SendApiHttpRequestInput<TRequest> {
    readonly baseUrl: string;
    readonly path: string;
    readonly method: ApiHttpMethod;
    /** Required by POST and PUT; absent, the request has no body. */
    readonly body: TRequest | undefined;
    /** Absent, the request reads the stored session and has no abort signal. */
    readonly options: ApiRequestOptions | undefined;
}

/** The session a request authenticates as: an absent `authSession` reads the stored session; `null` is none. */
export function readApiRequestSession(options: ApiRequestOptions): AuthSession | undefined {
    if (options.authSession === undefined) {
        return readSession();
    }
    return options.authSession ?? undefined;
}

/** A malformed caller `traceId` is refused with the send path's `RallarValidationError` before any request. */
export function newApiRequestHeaders(options: ApiRequestOptions): Headers {
    const traceId = options.traceId === undefined
        ? newALTraceId()
        : decodeALTraceId(options.traceId).fold((issue) => throwRallarValidation([issue]), (value) => value);
    const headers = new Headers({ 'content-type': 'application/json', 'x-request-id': traceId });
    const session = readApiRequestSession(options);
    if (session) {
        headers.set('authorization', `Bearer ${session.accessToken}`);
        headers.set('x-client-id', session.clientId);
    }
    return headers;
}

export async function readApiErrorBody(response: Response): Promise<string> {
    try {
        return await response.text();
    }
    catch {
        return '';
    }
}

export async function sendApiHttpRequest<TRequest, TResult>(
    input: SendApiHttpRequestInput<TRequest>
): Promise<TResult> {
    const options = input.options ?? {};
    const response = await fetch(`${input.baseUrl}${input.path}`, {
        method: input.method,
        headers: newApiRequestHeaders(options),
        signal: options.signal,
        body: toHttpRequestBody(input, options)
    });
    if (!response.ok) {
        throw new ApiHttpError(
            input.method,
            input.path,
            response.status,
            await readApiErrorBody(response),
            response.headers
        );
    }
    return (await response.json()) as TResult;
}

function toHttpRequestBody<TRequest>(
    { method, path, body }: SendApiHttpRequestInput<TRequest>,
    options: ApiRequestOptions
): string | undefined {
    if ((method === 'POST' || method === 'PUT') && body === undefined) {
        throw new Error(`${method} ${path} requires a body`);
    }
    if (method === 'GET' || body === undefined) {
        return undefined;
    }
    return JSON.stringify(toRequestIdFreeBody(body, options));
}

function toRequestIdFreeBody<TRequest>(body: TRequest, options: ApiRequestOptions): TRequest | object {
    if (
        !('requestId' in options) ||
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body)
    ) {
        return body;
    }

    return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'));
}

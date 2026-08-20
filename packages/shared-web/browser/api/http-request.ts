import type { AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';

import { ApiHttpError, type ApiHttpMethod } from './http-error.ts';

export type ApiRequestOptions = Readonly<{
    signal?: AbortSignal;
    authSession?: AuthSession | null;
}>;

export async function executeHttpRequest<Request, Result>(
    baseUrl: string,
    path: string,
    method: ApiHttpMethod,
    body: Request | undefined,
    options: ApiRequestOptions = {},
    requestHeaders: Readonly<Record<string, string>> = {},
): Promise<Result> {
    const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json', ...requestHeaders },
        signal: options.signal,
    };
    const session = options.authSession === undefined ? readSession() : options.authSession;
    addAuthHeaders(init, session);
    addRequestBody(init, method, path, body);
    const response = await fetch(`${baseUrl}${path}`, init);
    if (!response.ok) {
        throw new ApiHttpError(
            method,
            path,
            response.status,
            await readErrorBody(response),
            response.headers,
        );
    }
    return (await response.json()) as Result;
}

function addAuthHeaders(init: RequestInit, session: AuthSession | null | undefined): void {
    if (!session) return;
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${session.accessToken}`);
    headers.set('x-client-id', session.clientId);
    init.headers = headers;
}

function addRequestBody<Request>(
    init: RequestInit,
    method: ApiHttpMethod,
    path: string,
    body: Request | undefined,
): void {
    if (method === 'POST' || method === 'PUT') {
        if (body === undefined) {
            throw new Error(`${method} ${path} requires a body`);
        }
        init.body = JSON.stringify(body);
    } else if (method === 'DELETE' && body !== undefined) {
        init.body = JSON.stringify(body);
    }
}

async function readErrorBody(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return '';
    }
}

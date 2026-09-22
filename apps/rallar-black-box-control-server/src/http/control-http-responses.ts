import { createControlResponseHeaders } from '../cors.ts';

export interface ControlHttpRejection {
    readonly status: number;
    readonly message: string;
}

export interface ControlHttpResponses {
    readonly corsOrigins: readonly string[];
    json<TBody>(body: TBody, status: number): Response;
    text(text: string, status: number, contentType: string): Response;
    empty(status: number): Response;
    rejection(rejection: ControlHttpRejection): Response;
}

export function createControlHttpResponses(corsOrigins: readonly string[]): ControlHttpResponses {
    const toHeaders = (contentType: string | undefined) =>
        createControlResponseHeaders(undefined, { contentType, corsOrigins });
    return {
        corsOrigins,
        json: (body, status) => new Response(JSON.stringify(body), { status, headers: toHeaders('application/json') }),
        text: (text, status, contentType) => new Response(text, { status, headers: toHeaders(contentType) }),
        empty: (status) => new Response(null, { status, headers: toHeaders(undefined) }),
        rejection: ({ status, message }) =>
            new Response(JSON.stringify({ error: message }), { status, headers: toHeaders('application/json') })
    };
}

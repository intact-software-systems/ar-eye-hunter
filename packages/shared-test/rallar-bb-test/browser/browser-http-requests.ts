import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestJsonValue
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope } from './browser-command-cancellation.ts';
import type { CommandWithId, WebSocketTicketResolution } from './browser-command-contracts.ts';
import {
    readBrowserCommandAuthSession,
    requireBrowserCommandFetch,
    type BrowserCommandEnvironment
} from './browser-command-environment.ts';
import {
    replaceCommandPlaceholders,
    requiresAuthSessionPlaceholder,
    requiresWsTicketPlaceholder,
    resolveConfigApiBaseUrl
} from './browser-command-placeholders.ts';
import { decodeBrowserCommandRecord } from './browser-command-values.ts';

type HttpRequestCommand = Extract<CommandWithId, { kind: 'http.request'; }>;

/** A JSON body as parsed, a text body trimmed to its limit, or nothing when the command asks for no body. */
type HttpResponseBody = RallarBlackBoxTestJsonValue | undefined;

interface BrowserHttpRequest {
    readonly url: string;
    readonly headers: HeadersInit | undefined;
    readonly resolvedRequest: HttpRequestCommand['request'];
}

interface BrowserHttpResponse {
    readonly response: Response;
    readonly body: HttpResponseBody;
    readonly url: string;
}

export async function requestWebSocketTicket(
    environment: BrowserCommandEnvironment,
    config: RallarBlackBoxTestConfig | undefined,
    session: AuthSession | undefined
): Promise<WebSocketTicketResolution> {
    if (!session) {
        throw new Error('Cannot request websocket ticket without a logged-in Rallar session.');
    }
    const apiBaseUrl = resolveConfigApiBaseUrl(config);
    if (!apiBaseUrl) {
        throw new Error('Cannot request websocket ticket without configured apiBaseUrl.');
    }

    const ticketPath = `/api/auth/ws-ticket/requests/${encodeURIComponent(environment.requestId())}`;
    const response = await requireBrowserCommandFetch(environment)(new URL(ticketPath, `${apiBaseUrl}/`).toString(), {
        method: 'POST',
        headers: withRallarAuthHeaders(undefined, session)
    });
    const body = decodeBrowserCommandRecord(await response.json()) ?? {};
    if (!response.ok) {
        throw new Error(`Websocket ticket request failed: ${response.status}`);
    }
    if (typeof body.ticket !== 'string' || body.ticket.length === 0) {
        throw new Error('Websocket ticket response did not include ticket.');
    }
    return {
        ticket: body.ticket,
        ...(typeof body.sessionId === 'string' && body.sessionId.length > 0 ? { sessionId: body.sessionId } : {})
    };
}

/** Runs http.request with the browser's fetch, attaching the Rallar session only to the configured API. */
export class BrowserHttpRequests {
    private readonly environment: BrowserCommandEnvironment;

    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
    }

    async httpRequest(
        command: HttpRequestCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const prepared = await this.readRequest(command, context);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        try {
            const response = await requireBrowserCommandFetch(this.environment)(prepared.url, {
                method: prepared.resolvedRequest.method,
                headers: prepared.headers,
                body: toRequestBody(prepared.resolvedRequest.body),
                credentials: prepared.resolvedRequest.credentials,
                mode: prepared.resolvedRequest.mode,
                signal: abort.signal
            });
            const body = await readHttpBody(response, command.response, this.environment.defaultHttpBodyLimit);
            return recordHttpResponse(command, context, { response, body, url: prepared.url });
        }
        finally {
            abort.cleanup();
        }
    }

    private async readRequest(
        command: HttpRequestCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<BrowserHttpRequest> {
        const config = context.config();
        const required = Boolean(command.request.path) || requiresAuthSessionPlaceholder(command.request);
        const session = await readBrowserCommandAuthSession({ command, context, required }, this.environment);
        const wsTicket = requiresWsTicketPlaceholder(command.request)
            ? await requestWebSocketTicket(this.environment, config, session)
            : undefined;
        const resolvedRequest = replaceCommandPlaceholders(command.request, { config, session, wsTicket });
        const resolvedCommand = { ...command, request: resolvedRequest };
        const url = toRequestUrl(resolvedCommand, config, session);
        const headers = shouldAttachRallarAuth(resolvedCommand, config, url)
            ? withRallarAuthHeaders(resolvedRequest.headers, session)
            : resolvedRequest.headers;
        return { url, headers, resolvedRequest };
    }
}

function recordHttpResponse(
    command: HttpRequestCommand,
    context: RallarBlackBoxTestCommandContext,
    received: BrowserHttpResponse
): RallarBlackBoxTestCommandOutcome {
    const { response, body, url } = received;
    const value = {
        url: response.url || url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: toHeadersRecord(response.headers),
        body
    };
    context.recordEvent({
        kind: 'event',
        topic: 'rallar.bb.http.response',
        commandId: command.commandId,
        transport: 'http',
        severity: response.ok ? 'info' : 'warning',
        payload: value
    });

    const acceptedStatusCodes = command.response?.acceptedStatusCodes;
    if (!acceptedStatusCodes || acceptedStatusCodes.includes(response.status)) {
        return { status: 'ok', value, nextStatus: context.state().status };
    }
    return {
        status: 'failed',
        value,
        error: {
            code: 'RALLAR_BLACK_BOX_HTTP_STATUS_NOT_ACCEPTED',
            message: `http.request received status ${response.status}; ` +
                `accepted status codes: ${acceptedStatusCodes.join(', ')}.`,
            details: value
        },
        nextStatus: 'failed'
    };
}

function shouldAttachRallarAuth(
    command: HttpRequestCommand,
    config: RallarBlackBoxTestConfig | undefined,
    url: string
): boolean {
    if (command.request.path) {
        return true;
    }
    const apiBaseUrl = resolveConfigApiBaseUrl(config);
    return apiBaseUrl !== undefined && (url === apiBaseUrl || url.startsWith(`${apiBaseUrl}/`));
}

function withRallarAuthHeaders(
    headers: HeadersInit | undefined,
    session: AuthSession | undefined
): HeadersInit | undefined {
    if (!session) {
        return headers;
    }
    const next = new Headers(headers);
    next.set('authorization', `Bearer ${session.accessToken}`);
    next.set('x-client-id', session.clientId);
    return toHeadersRecord(next);
}

function toHeadersRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}

function toRequestBody(body: RallarBlackBoxTestHttpRequestCommand['request']['body']): string | undefined {
    if (body === undefined) {
        return undefined;
    }
    return typeof body === 'string' ? body : JSON.stringify(body);
}

async function readHttpBody(
    response: Response,
    responseOptions: RallarBlackBoxTestHttpRequestCommand['response'],
    defaultLimit: number
): Promise<HttpResponseBody> {
    const bodyMode = responseOptions?.body ?? 'text';
    if (bodyMode === 'none') {
        return undefined;
    }
    if (bodyMode === 'json') {
        return await response.json();
    }
    const text = await response.text();
    const limit = responseOptions?.maxBodyChars ?? defaultLimit;
    return text.length > limit ? text.slice(0, limit) : text;
}

function toRequestUrl(
    command: HttpRequestCommand,
    config: RallarBlackBoxTestConfig | undefined,
    session: AuthSession | undefined
): string {
    const placeholderValues = { config, session, wsTicket: undefined };
    if (command.request.url) {
        return replaceCommandPlaceholders(command.request.url, placeholderValues);
    }
    if (!command.request.path) {
        throw new Error('http.request requires request.url or request.path.');
    }
    const apiBaseUrl = resolveConfigApiBaseUrl(config);
    if (!apiBaseUrl) {
        throw new Error('http.request path requires configured apiBaseUrl.');
    }
    return new URL(replaceCommandPlaceholders(command.request.path, placeholderValues), `${apiBaseUrl}/`).toString();
}

import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope } from './browser-command-cancellation.ts';
import { CommandWithId, HttpResponseOptions, WebSocketTicketResolution } from './browser-command-contracts.ts';
import {
    BrowserCommandEnvironment,
    readBrowserCommandAuthSession,
    requireBrowserCommandFetch
} from './browser-command-environment.ts';
import {
    configApiBaseUrl,
    replaceCommandPlaceholders,
    requiresWsTicketPlaceholder
} from './browser-command-placeholders.ts';
import { toBrowserCommandRecord } from './browser-command-values.ts';

export async function requestWebSocketTicket(
    environment: BrowserCommandEnvironment,
    config: RallarBlackBoxTestConfig | undefined,
    session: AuthSession | undefined
): Promise<WebSocketTicketResolution> {
    if (!session) {
        throw new Error(
            'Cannot request websocket ticket without a logged-in Rallar session.'
        );
    }

    const apiBaseUrl = configApiBaseUrl(config);
    if (!apiBaseUrl) {
        throw new Error(
            'Cannot request websocket ticket without configured apiBaseUrl.'
        );
    }

    const ticketPath = `/api/auth/ws-ticket/requests/${encodeURIComponent(environment.requestId())}`;
    const response = await requireBrowserCommandFetch(environment)(
        new URL(ticketPath, `${apiBaseUrl}/`).toString(),
        {
            method: 'POST',
            headers: withRallarAuthHeaders(undefined, session)
        }
    );
    const body = toBrowserCommandRecord(await response.json());
    if (!response.ok) {
        throw new Error(`Websocket ticket request failed: ${response.status}`);
    }
    if (typeof body.ticket !== 'string' || body.ticket.length === 0) {
        throw new Error('Websocket ticket response did not include ticket.');
    }

    return {
        ticket: body.ticket,
        ...(typeof body.sessionId === 'string' && body.sessionId.length > 0
            ? { sessionId: body.sessionId }
            : {})
    };
}

export function shouldAttachRallarAuth(
    command: Extract<CommandWithId, { kind: 'http.request'; }>,
    config: RallarBlackBoxTestConfig | undefined,
    url: string
): boolean {
    if (command.request.path) {
        return true;
    }

    const apiBaseUrl = configApiBaseUrl(config);
    if (!apiBaseUrl) {
        return false;
    }

    return url === apiBaseUrl || url.startsWith(`${apiBaseUrl}/`);
}

export function withRallarAuthHeaders(
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

export function toHeadersRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}

export function trimTextBody(body: string, limit: number): string {
    return body.length > limit ? body.slice(0, limit) : body;
}

export async function readHttpBody(
    response: Response,
    responseOptions: HttpResponseOptions | undefined,
    defaultLimit: number
): Promise<unknown> {
    const bodyMode = responseOptions?.body ?? 'text';
    if (bodyMode === 'none') {
        return undefined;
    }

    if (bodyMode === 'json') {
        return await response.json();
    }

    return trimTextBody(
        await response.text(),
        responseOptions?.maxBodyChars ?? defaultLimit
    );
}

export function toRequestUrl(
    request: RallarBlackBoxTestCommand & { kind: 'http.request'; },
    config: RallarBlackBoxTestConfig | undefined,
    session: AuthSession | undefined
): string {
    const requestUrl = replaceCommandPlaceholders(request.request.url, {
        config,
        session
    });
    if (request.request.url) {
        return requestUrl ?? request.request.url;
    }

    if (!request.request.path) {
        throw new Error('http.request requires request.url or request.path.');
    }

    const apiBaseUrl = configApiBaseUrl(config);
    if (!apiBaseUrl) {
        throw new Error('http.request path requires configured apiBaseUrl.');
    }

    const path = replaceCommandPlaceholders(request.request.path, {
        config,
        session
    });
    return new URL(path, `${apiBaseUrl}/`).toString();
}

export class BrowserHttpRequests {
    readonly environment: BrowserCommandEnvironment;
    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
    }
    async httpRequest(
        command: Extract<CommandWithId, { kind: 'http.request'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const prepared = await this.readRequest(command, context);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        try {
            const response = await requireBrowserCommandFetch(this.environment)(prepared.url, {
                method: prepared.resolvedRequest.method,
                headers: prepared.headers,
                body: prepared.resolvedRequest.body === undefined
                    ? undefined
                    : typeof prepared.resolvedRequest.body === 'string'
                    ? prepared.resolvedRequest.body
                    : JSON.stringify(prepared.resolvedRequest.body),
                credentials: prepared.resolvedRequest.credentials,
                mode: prepared.resolvedRequest.mode,
                signal: abort.signal
            });
            const body = await readHttpBody(response, command.response, this.environment.defaultHttpBodyLimit);
            return this.recordResponse(command, context, { response, body, url: prepared.url });
        }
        finally {
            abort.cleanup();
        }
    }

    async readRequest(
        command: Extract<CommandWithId, { kind: 'http.request'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<BrowserHttpRequest> {
        const config = context.config();
        const session = await readBrowserCommandAuthSession({
            value: command.request,
            command,
            context,
            required: Boolean(command.request.path)
        }, this.environment);
        const wsTicket = requiresWsTicketPlaceholder(command.request)
            ? await requestWebSocketTicket(this.environment, config, session)
            : undefined;
        const resolvedRequest = replaceCommandPlaceholders(command.request, {
            config,
            session,
            wsTicket
        });
        const resolvedCommand = {
            ...command,
            request: resolvedRequest
        };
        const url = toRequestUrl(resolvedCommand, config, session);
        const headers = shouldAttachRallarAuth(resolvedCommand, config, url)
            ? withRallarAuthHeaders(resolvedRequest.headers, session)
            : resolvedRequest.headers;

        return { url, headers, resolvedRequest };
    }

    recordResponse(
        command: Extract<CommandWithId, { kind: 'http.request'; }>,
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

        if (
            command.response?.acceptedStatusCodes &&
            !command.response.acceptedStatusCodes.includes(response.status)
        ) {
            const accepted = command.response.acceptedStatusCodes.join(', ');
            return {
                status: 'failed',
                value,
                error: {
                    code: 'RALLAR_BLACK_BOX_HTTP_STATUS_NOT_ACCEPTED',
                    message: `http.request received status ${response.status}; ` +
                        `accepted status codes: ${accepted}.`,
                    details: value
                },
                nextStatus: 'failed'
            };
        }

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status
        };
    }
}
interface BrowserHttpRequest {
    readonly url: string;
    readonly headers: HeadersInit | undefined;
    readonly resolvedRequest: Extract<CommandWithId, { kind: 'http.request'; }>['request'];
}
interface BrowserHttpResponse {
    readonly response: Response;
    readonly body: unknown;
    readonly url: string;
}

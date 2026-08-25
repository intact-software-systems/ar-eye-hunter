import type { AuthSession } from '@shared/api/api-config.ts';

import type { AuthCommandCenterTicket } from '../../legacy/diagnostics/shared/auth-command-center-ticket.ts';

export interface ResolveWebSocketUrlTemplateInput {
    readonly template: string;
    readonly apiBaseUrl: string;
    readonly authSession: AuthSession | undefined;
    readonly ticket: AuthCommandCenterTicket | undefined;
}

export function defaultWebSocketApiUrl(apiBaseUrl: string): string {
    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/api/ws/{auth.sessionId}';
        url.search = 'ticket={auth.wsTicket}';
        return url.toString();
    }
    catch {
        return 'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}';
    }
}

export function resolveWebSocketUrlTemplate(input: ResolveWebSocketUrlTemplateInput): string {
    return input.template
        .replaceAll(
            '{auth.sessionId}',
            encodeURIComponent(input.authSession?.sessionId ?? input.ticket?.sessionId ?? '')
        )
        .replaceAll('{auth.wsTicket}', encodeURIComponent(input.ticket?.ticket ?? ''))
        .replaceAll('{config.wsBaseUrl}', resolveWebSocketBaseUrl(input.apiBaseUrl));
}

function resolveWebSocketBaseUrl(apiBaseUrl: string): string {
    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '';
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    }
    catch {
        return 'ws://localhost:8080';
    }
}

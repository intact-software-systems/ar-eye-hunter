import type { AuthSession } from '@shared/api/api-config.ts';
import {
    consumeAgentSessionTicketAt,
} from '@shared-web/browser/auth/agent-session-ticket-http-api.ts';

const BOOTSTRAP_FRAGMENT_SECRET_FIELDS = [
    'agentSessionTicket',
    'controlToken',
] as const;

let pendingAgentSessionTicketConsume:
    | Readonly<{
        ticket: string;
        apiBaseUrl: string;
        promise: Promise<AuthSession>;
    }>
    | undefined;

export function scrubBrowserAgentBootstrapSecretsFromUrl(): void {
    if (typeof window === 'undefined') return;

    const nextUrl = new URL(window.location.href);
    let changed = nextUrl.searchParams.has('controlToken');
    nextUrl.searchParams.delete('controlToken');
    const fragment = new URLSearchParams(
        nextUrl.hash.startsWith('#') ? nextUrl.hash.slice(1) : nextUrl.hash,
    );
    for (const field of BOOTSTRAP_FRAGMENT_SECRET_FIELDS) {
        changed = fragment.has(field) || changed;
        fragment.delete(field);
    }
    if (!changed) return;

    nextUrl.hash = fragment.toString();
    window.history.replaceState(null, document.title, nextUrl.toString());
}

export function scrubAgentSessionTicketFromUrl(): void {
    scrubBrowserAgentBootstrapSecretsFromUrl();
}

export function consumeBootstrapAgentSessionTicket(
    ticket: string,
    apiBaseUrl: string,
): Promise<AuthSession> {
    const normalizedApiBaseUrl = apiBaseUrl.trim().replace(/\/+$/, '');
    if (
        pendingAgentSessionTicketConsume?.ticket === ticket &&
        pendingAgentSessionTicketConsume.apiBaseUrl === normalizedApiBaseUrl
    ) {
        return pendingAgentSessionTicketConsume.promise;
    }

    const promise = consumeAgentSessionTicketAt(
        normalizedApiBaseUrl,
        { ticket },
    ).finally(() => {
        if (pendingAgentSessionTicketConsume?.promise === promise) {
            pendingAgentSessionTicketConsume = undefined;
        }
    });
    pendingAgentSessionTicketConsume = {
        ticket,
        apiBaseUrl: normalizedApiBaseUrl,
        promise,
    };
    return promise;
}

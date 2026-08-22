import { consumeAgentSessionTicketAt } from '@shared-web/browser/auth/agent-session-ticket-http-api.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

const BOOTSTRAP_FRAGMENT_SECRET_FIELDS = [
    'agentSessionTicket',
    'controlToken'
] as const;

let pendingAgentSessionTicketConsume:
    | Readonly<{
        ticket: string;
        apiBaseUrl: string;
        requestId: string;
        promise?: Promise<AuthSession>;
    }>
    | undefined;

export function scrubBrowserAgentBootstrapSecretsFromUrl(): void {
    if (typeof window === 'undefined') {
        return;
    }

    const nextUrl = new URL(window.location.href);
    let changed = nextUrl.searchParams.has('controlToken');
    nextUrl.searchParams.delete('controlToken');
    const fragment = new URLSearchParams(
        nextUrl.hash.startsWith('#') ? nextUrl.hash.slice(1) : nextUrl.hash
    );
    for (const field of BOOTSTRAP_FRAGMENT_SECRET_FIELDS) {
        changed = fragment.has(field) || changed;
        fragment.delete(field);
    }
    if (!changed) {
        return;
    }

    nextUrl.hash = fragment.toString();
    window.history.replaceState(null, document.title, nextUrl.toString());
}

export function scrubAgentSessionTicketFromUrl(): void {
    scrubBrowserAgentBootstrapSecretsFromUrl();
}

export function consumeBootstrapAgentSessionTicket(
    ticket: string,
    apiBaseUrl: string
): Promise<AuthSession> {
    const normalizedApiBaseUrl = apiBaseUrl.trim().replace(/\/+$/, '');
    const current = pendingAgentSessionTicketConsume;
    const isSameAttempt = current?.ticket === ticket &&
        current.apiBaseUrl === normalizedApiBaseUrl;
    if (isSameAttempt && current.promise) {
        return current.promise;
    }

    const requestId = isSameAttempt ? current.requestId : crypto.randomUUID();
    const promise = consumeAgentSessionTicketAt(
        normalizedApiBaseUrl,
        { ticket },
        { requestId }
    ).then((session) => {
        if (pendingAgentSessionTicketConsume?.promise === promise) {
            pendingAgentSessionTicketConsume = undefined;
        }
        return session;
    }).catch((error) => {
        if (pendingAgentSessionTicketConsume?.promise === promise) {
            pendingAgentSessionTicketConsume = {
                ticket,
                apiBaseUrl: normalizedApiBaseUrl,
                requestId
            };
        }
        throw error;
    });
    pendingAgentSessionTicketConsume = {
        ticket,
        apiBaseUrl: normalizedApiBaseUrl,
        requestId,
        promise
    };
    return promise;
}

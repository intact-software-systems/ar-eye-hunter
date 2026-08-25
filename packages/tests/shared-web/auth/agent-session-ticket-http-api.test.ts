import { configureApiClient, readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { consumeAgentSessionTicketAt, issueAgentSessionTicketsAt } from '@shared-web/browser/auth/agent-session-ticket-http-api.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('agent session ticket HTTP API', () => {
    beforeEach(installEmptyLocalStorage);

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
    });

    it('uses an explicit API base without changing the configured base', async () => {
        const urls: string[] = [];
        stubFetch(urls, (url) =>
            url.includes('/consume/')
                ? jsonResponse(authSession())
                : jsonResponse({ tickets: [] }));
        configureApiClient({ apiBaseUrl: 'https://browser-api.example.test' });

        await issueAgentSessionTicketsAt(
            'https://agent-api.example.test',
            { agentIds: ['agent-1'] },
            { requestId: 'agent-issue-request-id', authSession: authSession() }
        );
        await consumeAgentSessionTicketAt(
            'https://agent-api.example.test',
            { ticket: 'ticket-1' },
            { requestId: 'agent-consume-request-id' }
        );

        expect(urls).toEqual([
            'https://agent-api.example.test/api/auth/agent-session-tickets/requests/agent-issue-request-id',
            'https://agent-api.example.test/api/auth/agent-session-tickets/consume/requests/agent-consume-request-id'
        ]);
        expect(readApiBaseUrl()).toBe('https://browser-api.example.test');
    });

    it('reuses caller-owned request IDs after lost responses', async () => {
        const urls: string[] = [];
        let attempt = 0;
        stubFetch(urls, (url) => {
            attempt += 1;
            if (attempt % 2 === 1) {
                return new Response('response lost', { status: 503 });
            }
            return url.includes('/consume/')
                ? jsonResponse(authSession())
                : jsonResponse({ tickets: [] });
        });
        const issueOptions = { requestId: 'agent-issue-lost-response-id', authSession: null } as const;
        const consumeOptions = { requestId: 'agent-consume-lost-response-id', authSession: null } as const;

        await expect(issueAgentSessionTicketsAt(
            'https://agent-api.example.test',
            { agentIds: ['agent-1'] },
            issueOptions
        )).rejects.toThrow('503');
        await issueAgentSessionTicketsAt(
            'https://agent-api.example.test',
            { agentIds: ['agent-1'] },
            issueOptions
        );
        await expect(consumeAgentSessionTicketAt(
            'https://agent-api.example.test',
            { ticket: 'ticket-1' },
            consumeOptions
        )).rejects.toThrow('503');
        await consumeAgentSessionTicketAt(
            'https://agent-api.example.test',
            { ticket: 'ticket-1' },
            consumeOptions
        );

        expect(urls.map((url) => new URL(url).pathname)).toEqual([
            '/api/auth/agent-session-tickets/requests/agent-issue-lost-response-id',
            '/api/auth/agent-session-tickets/requests/agent-issue-lost-response-id',
            '/api/auth/agent-session-tickets/consume/requests/agent-consume-lost-response-id',
            '/api/auth/agent-session-tickets/consume/requests/agent-consume-lost-response-id'
        ]);
    });
});

function stubFetch(urls: string[], respond: (url: string) => Response): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            urls.push(url);
            return respond(url);
        })
    );
}

function jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function authSession() {
    return {
        clientId: 'operator-client',
        accessToken: 'operator-token',
        username: 'alice',
        sessionId: 'operator-session',
        expiresAtEpochMs: 10_000
    };
}

function installEmptyLocalStorage(): void {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    });
}

// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { AuthSession, LoginRequest } from '@shared/api/api-config.ts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthCommandCenterPanel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/auth/auth-command-center-panel.tsx';

interface RecordedRequest {
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
    readonly body: string | undefined;
}

const bootstrapPatches = vi.hoisted(() => [] as Array<Record<string, string | boolean | undefined>>);
const loadFacade = vi.hoisted(() => vi.fn());
const restorableSession = vi.hoisted(() => ({ current: undefined as undefined | Record<string, string | number> }));
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { updateBootstrapConfig: (patch: Record<string, string | boolean | undefined>) => bootstrapPatches.push(patch) },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
}));
vi.mock('../../../apps/rallar-black-box/src/legacy/rallar/load-browser-rallar-facade.ts', () => ({ loadBrowserRallarFacade: loadFacade }));
vi.mock('../../../apps/rallar-black-box/src/legacy/shell/read-current-auth-session.ts', () => ({
    readCurrentAuthSession: () => restorableSession.current
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = {
    clientId: 'client',
    sessionId: 'session',
    username: 'user',
    accessToken: 'auth-secret-token',
    expiresAtEpochMs: Date.now() + 60_000
};

const CLIPBOARD_FAILURES = [
    {
        name: 'an unavailable clipboard',
        arrange: () => vi.spyOn(navigator, 'clipboard', 'get').mockImplementation(() => Reflect.get({}, 'clipboard')),
        error: 'Clipboard access is unavailable in this browser.'
    },
    {
        name: 'a rejected copy',
        arrange: () => vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied')),
        error: 'Unable to copy to the clipboard. Check browser permissions and try again.'
    }
];

describe('auth command-center panel preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    const requests: RecordedRequest[] = [];
    const authenticated: Array<string | undefined> = [];
    const logins: string[] = [];
    const copied: string[] = [];
    let logouts = 0;
    let loginFailure: Error | undefined;

    async function render(
        session: AuthSession | undefined = authSession,
        apiBaseUrl = 'http://localhost:18080'
    ): Promise<void> {
        await act(async () =>
            root.render(createElement(AuthCommandCenterPanel, {
                state,
                bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar&apiBaseUrl=http%3A%2F%2Flocalhost%3A18080', {}, ''),
                authSession: session,
                globalValues: {
                    apiBaseUrl,
                    applicationId: 'app',
                    workspaceId: 'workspace',
                    clientId: 'client',
                    sessionId: 'session',
                    roomId: 'room-a'
                },
                onAuthenticated: (next) => authenticated.push(next?.sessionId),
                onLogout: async () => {
                    logouts += 1;
                }
            }))
        );
    }

    function field(label: string): HTMLInputElement {
        const control = [...container.querySelectorAll('label')]
            .find((candidate) => candidate.querySelector('span')?.textContent === label)
            ?.querySelector('input');
        if (!(control instanceof HTMLInputElement)) {
            throw new Error(`Missing ${label} field`);
        }
        return control;
    }

    async function type(label: string, value: string): Promise<void> {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        await act(async () => {
            setValue?.call(field(label), value);
            field(label).dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    function actionRows(): readonly string[] {
        return [...container.querySelectorAll('.command-center-action-row')].map((row) =>
            `${row.querySelector('strong')?.textContent} ${row.querySelector('.pill')?.textContent}`
        );
    }

    async function click(name: string): Promise<void> {
        const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
        if (!button) {
            throw new Error(`Missing ${name} button`);
        }
        await act(async () => button.click());
        for (let attempt = 0; attempt < 20 && container.querySelector('.command-center-status[role="status"]'); attempt += 1) {
            await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
        }
    }

    function definition(term: string): string | undefined {
        return [...container.querySelectorAll('dt')]
            .find((candidate) => candidate.textContent === term)
            ?.nextElementSibling?.textContent ?? undefined;
    }

    beforeEach(() => {
        requests.length = 0;
        authenticated.length = 0;
        logins.length = 0;
        copied.length = 0;
        bootstrapPatches.length = 0;
        logouts = 0;
        loginFailure = undefined;
        restorableSession.current = undefined;
        const storedSessions = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storedSessions.get(key) ?? null,
            setItem: (key: string, value: string) => storedSessions.set(key, value),
            removeItem: (key: string) => storedSessions.delete(key)
        });
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        loadFacade.mockResolvedValue({
            configure: (config: { apiBaseUrl: string; }) => logins.push(`configure ${config.apiBaseUrl}`),
            auth: {
                login: async (request: LoginRequest) => {
                    logins.push(`login ${request.username}`);
                    if (loginFailure) {
                        throw loginFailure;
                    }
                    return { ...authSession, sessionId: 'logged-in-session', username: request.username };
                },
                registerAndLogin: async (request: LoginRequest) => {
                    logins.push(`register ${request.username}`);
                    return { ...authSession, sessionId: 'registered-session', username: request.username };
                }
            }
        });
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            const headers = (init.headers ?? {}) as Record<string, string>;
            const path = new URL(url).pathname;
            requests.push({
                method: String(init.method),
                path,
                authorization: headers.authorization,
                body: init.body === undefined ? undefined : String(init.body)
            });
            const authorized = headers.authorization !== undefined && path.startsWith('/api/auth/ws-ticket');
            return new Response(
                JSON.stringify(
                    authorized ? { ticket: 'ticket-secret', sessionId: 'session', expiresAtEpochMs: Date.now() + 30_000 } : { error: 'unauthorized' }
                ),
                { status: authorized ? 200 : 401, statusText: authorized ? 'OK' : 'Unauthorized', headers: { 'content-type': 'application/json' } }
            );
        });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends the operator auth probes as path-identified mutations and records each response', async () => {
        await render();
        await click('Bad credentials');
        await click('Missing auth ticket');
        await click('Expired auth ticket');
        await click('Create WS ticket');

        expect({
            requests: requests.map(({ method, path, authorization, body }) => ({
                method,
                path: path.replace(/\/requests\/[^/]+$/, '/requests/{requestId}'),
                authorization,
                body
            })),
            actions: [...container.querySelectorAll('.command-center-action-row')].map((row) => [
                row.querySelector('strong')?.textContent,
                row.querySelector('.pill')?.textContent
            ]),
            ticket: definition('WS ticket'),
            error: container.querySelector('.workbench-error')?.textContent,
            leaked: container.textContent?.includes('auth-secret-token') || container.textContent?.includes('ticket-secret')
        }).toEqual({
            requests: [
                {
                    method: 'POST',
                    path: '/api/auth/login/requests/{requestId}',
                    authorization: undefined,
                    body: '{"username":"user","password":"bad-invalid"}'
                },
                { method: 'POST', path: '/api/auth/ws-ticket/requests/{requestId}', authorization: undefined, body: '{}' },
                { method: 'POST', path: '/api/auth/ws-ticket/requests/{requestId}', authorization: 'Bearer auth-secret-token', body: '{}' },
                { method: 'POST', path: '/api/auth/ws-ticket/requests/{requestId}', authorization: 'Bearer auth-secret-token', body: '{}' }
            ],
            actions: [
                ['Create WS ticket', '200'],
                ['Expired auth WS ticket', '200'],
                ['Missing auth WS ticket', '401'],
                ['Bad credentials', '401']
            ],
            ticket: 'redacted',
            error: undefined,
            leaked: false
        });
    });

    it('keeps the current ticket and shows no error when a created-ticket response carries no complete ticket', async () => {
        await render();
        await click('Create WS ticket');
        const created = definition('Ticket expires');
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(JSON.stringify({ sessionId: 'session' }), { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } })
        );
        await click('Create WS ticket');

        expect({
            kept: definition('Ticket expires') === created,
            ticket: definition('WS ticket'),
            error: container.querySelector('.workbench-error')?.textContent,
            rows: actionRows()
        }).toEqual({
            kept: true,
            ticket: 'redacted',
            error: undefined,
            rows: ['Create WS ticket 200', 'Create WS ticket 200']
        });
    });

    it('shows a request that cannot be built as a local error without sending it', async () => {
        await render();
        const apiBaseUrl = [...container.querySelectorAll('label')]
            .find((candidate) => candidate.querySelector('span')?.textContent === 'API Base URL')
            ?.querySelector('input');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        await act(async () => {
            setValue?.call(apiBaseUrl, ' ');
            apiBaseUrl?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click('Bad credentials');

        expect({
            requests: requests.length,
            error: container.querySelector('.workbench-error')?.textContent,
            actions: container.querySelectorAll('.command-center-action-row').length
        }).toEqual({
            requests: 0,
            error: 'Rallar Server API base URL is required.',
            actions: 0
        });
    });
    it('logs in, registers and logs in, and shows a rejected login', async () => {
        await render(undefined);
        await type('Username', 'operator');
        await type('Password', 'pass-word');
        await click('Login');
        await click('Register and login');
        const succeeded = { authenticated: [...authenticated], logins: [...logins], rows: actionRows(), patches: bootstrapPatches.length };
        loginFailure = new ApiHttpError('POST', '/api/auth/login', 401, JSON.stringify({ code: 'auth-invalid-credentials' }));
        await click('Login');

        expect({ succeeded, error: container.querySelector('.workbench-error')?.textContent, authenticated }).toEqual({
            succeeded: {
                authenticated: ['logged-in-session', 'registered-session'],
                logins: ['configure http://localhost:18080', 'login operator', 'configure http://localhost:18080', 'register operator'],
                rows: ['Register and login 201', 'Login 200'],
                patches: 2
            },
            error: expect.stringContaining('401'),
            authenticated: ['logged-in-session', 'registered-session']
        });
    });

    it('restores, clears and logs out the browser session', async () => {
        await render();
        await click('Restore session');
        const missing = container.querySelector('.workbench-error')?.textContent;
        restorableSession.current = { ...authSession, sessionId: 'restored-session' };
        await click('Restore session');
        await click('Clear local session');
        await click('Logout');

        expect({ missing, authenticated, rows: actionRows(), logouts, patches: bootstrapPatches.length }).toEqual({
            missing: 'No restorable browser auth session was found.',
            authenticated: [undefined, 'restored-session', undefined],
            rows: ['Clear local session 200', 'Restore session 200'],
            logouts: 1,
            patches: 1
        });
    });

    it('follows the global API base URL and copies redacted diagnostics and a strict recipe', async () => {
        await render();
        await render(authSession, 'http://localhost:18090');
        const followed = field('API Base URL').value;
        await click('Create WS ticket');
        await click('Copy diagnostics');
        await click('Copy auth recipe');
        const diagnostics = JSON.parse(copied[0] ?? 'null');

        expect({
            followed,
            ticketRequest: requests[0]?.path.startsWith('/api/auth/ws-ticket/requests/'),
            diagnostics: [diagnostics?.apiBaseUrl, diagnostics?.wsTicket, diagnostics?.recentActions?.length],
            leaked: copied.some((text) => text.includes('auth-secret-token') || text.includes('ticket-secret')),
            recipe: JSON.parse(copied[1] ?? 'null')?.recipeId
        }).toEqual({
            followed: 'http://localhost:18090',
            ticketRequest: true,
            diagnostics: ['http://localhost:18090', '<redacted>', 1],
            leaked: false,
            recipe: 'rallar-auth-command-center'
        });
    });

    it.each(
        CLIPBOARD_FAILURES.flatMap((failure) => [
            { ...failure, button: 'Copy diagnostics' },
            { ...failure, button: 'Copy auth recipe' }
        ])
    )('shows $name as a visible error from $button', async ({ arrange, button, error }) => {
        await render();
        arrange();
        await click(button);

        expect({ error: container.querySelector('.workbench-error')?.textContent, copies: copied.length }).toEqual({ error, copies: 0 });
    });
});

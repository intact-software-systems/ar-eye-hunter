// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
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

vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { updateBootstrapConfig: () => {} },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
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

describe('auth command-center panel preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    const requests: RecordedRequest[] = [];

    async function render(): Promise<void> {
        await act(async () =>
            root.render(createElement(AuthCommandCenterPanel, {
                state,
                bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar&apiBaseUrl=http%3A%2F%2Flocalhost%3A18080', {}, ''),
                authSession,
                globalValues: {
                    apiBaseUrl: 'http://localhost:18080',
                    applicationId: 'app',
                    workspaceId: 'workspace',
                    clientId: 'client',
                    sessionId: 'session',
                    roomId: 'room-a'
                },
                onAuthenticated: () => {},
                onLogout: async () => {}
            }))
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
});

// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '../../shared/api/api-config.ts';
import {
    createBrowserAgentLaunchService,
} from '../../../apps/rallar-black-box/src/browser-agent-launch-service.ts';
import {
    controlWebSocketUrlFromHttpBaseUrl,
} from '../../../apps/rallar-black-box/src/runner-agent-launch.ts';
import {
    createRecipeConsoleControlAgentLaunchApi,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-agent-launch-api.ts';
import {
    ControlConnectionProvider,
    type RecipeConsoleControlConnection,
    useControlConnection,
} from '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import type {
    RecipeConsoleControlCredentialPolicy,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-credential-policy.ts';
import {
    navigateReservedBrowserAgentPopups,
    reserveBrowserAgentPopups,
    releaseReservedBrowserAgentPopups,
} from '../../../apps/rallar-black-box/src/browser-agent-popup.ts';
import {
    createRunnerAgentLaunchActions,
} from '../../../apps/rallar-black-box/src/legacy/runner/recipes/runner-agent-launch-actions.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const group = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'room-1',
} as const;

describe('Recipe Console browser-agent launch service', () => {
    it('prepares exact simulated identities with distinct least-privilege control tokens', async () => {
        const selectedGroup = {
            applicationId: 'selected-app',
            workspaceId: 'selected-workspace',
            groupId: 'selected-room',
        } as const;
        const issueRunToken = vi.fn(async ({ runId, agentId }: {
            runId: string;
            agentId: string;
        }) => ({
            runId,
            agentId,
            token: `control-${agentId}`,
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 61_000,
        }));
        const service = createBrowserAgentLaunchService({
            origin: 'https://blackbox.example.test',
            providerMode: 'simulated',
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
            issueRunToken,
        });

        const result = await service.prepare({
            runId: 'human-flow-run',
            agentIds: ['operator-a-1', 'operator-a-2', 'operator-a-3'],
            group: selectedGroup,
        });

        expect(result).toMatchObject({
            runId: 'human-flow-run',
            group: selectedGroup,
            providerMode: 'simulated',
        });
        expect(issueRunToken).toHaveBeenCalledTimes(3);
        expect(result.agents.map(agent => agent.agentId)).toEqual([
            'operator-a-1',
            'operator-a-2',
            'operator-a-3',
        ]);
        for (const agent of result.agents) {
            const url = new URL(agent.launchUrl);
            expect(url.searchParams.get('mode')).toBe('control');
            expect(url.searchParams.get('runId')).toBe('human-flow-run');
            expect(url.searchParams.get('agentId')).toBe(agent.agentId);
            expect(url.searchParams.get('roomId')).toBe('selected-room');
            expect(url.searchParams.get('applicationId')).toBe('selected-app');
            expect(url.searchParams.get('workspaceId')).toBe('selected-workspace');
            expect(url.searchParams.get('provider')).toBe('simulated');
            expect(url.searchParams.get('controlUrl')).toBe('wss://control.example.test/control');
            expect(url.searchParams.get('apiBaseUrl')).toBe('https://api.example.test');
            expect(url.searchParams.get('actor')).toBe(agent.agentId);
            expect(url.searchParams.get('sessionId')).toBe(`${agent.agentId}-session`);
            expect(url.searchParams.get('controlToken')).toBeNull();
            expect(new URLSearchParams(url.hash.slice(1)).get('controlToken'))
                .toBe(`control-${agent.agentId}`);
        }
    });

    it('requires login and validates an exact fresh browser-rallar ticket batch', async () => {
        const authSession: AuthSession = {
            clientId: 'operator-client',
            accessToken: 'operator-token',
            username: 'alice',
            sessionId: 'operator-session',
            expiresAtEpochMs: 100_000,
        };
        const issueAgentTickets = vi.fn(async () => ({ tickets: [{
            agentId: 'browser-1',
            ticket: 'api-ticket-1',
            sessionId: 'fresh-session-1',
            expiresAtEpochMs: 50_000,
        }] }));
        const create = (session?: AuthSession) => createBrowserAgentLaunchService({
            origin: 'https://blackbox.example.test',
            providerMode: 'browser-rallar',
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
            authSession: session,
            issueRunToken: async ({ runId, agentId }) => ({
                runId,
                agentId,
                token: 'control-token-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 60_000,
            }),
            issueAgentTickets,
        });

        await expect(create().prepare({
            runId: 'run-1',
            agentIds: ['browser-1'],
            group,
        })).rejects.toThrow('logged-in operator');

        const result = await create(authSession).prepare({
            runId: 'run-1',
            agentIds: ['browser-1'],
            group,
        });
        const url = new URL(result.agents[0].launchUrl);
        expect(issueAgentTickets).toHaveBeenCalledWith(
            'https://api.example.test',
            { agentIds: ['browser-1'] },
            { authSession, signal: undefined },
        );
        expect(url.searchParams.get('sessionId')).toBeNull();
        expect(url.searchParams.get('actor')).toBe('alice');
        expect(url.searchParams.get('controlToken')).toBeNull();
        expect(url.search).not.toContain('fresh-session-1');
        expect(new URLSearchParams(url.hash.slice(1))).toMatchObject(expect.any(URLSearchParams));
        expect(new URLSearchParams(url.hash.slice(1)).get('controlToken')).toBe('control-token-1');
        expect(new URLSearchParams(url.hash.slice(1)).get('agentSessionTicket')).toBe('api-ticket-1');
        expect(result.agents[0].expiresAtEpochMs).toBe(50_000);
    });

    it.each([
        ['ticket', 'shared-ticket', 'shared-ticket', 'session-1', 'session-2'],
        ['session ID', 'ticket-1', 'ticket-2', 'shared-session', 'shared-session'],
    ] as const)(
        'rejects a browser-rallar batch with duplicate %s authority',
        async (_label, firstTicket, secondTicket, firstSession, secondSession) => {
            const service = createBrowserAgentLaunchService({
                origin: 'https://blackbox.example.test',
                providerMode: 'browser-rallar',
                controlWsUrl: 'wss://control.example.test/control',
                apiBaseUrl: 'https://api.example.test',
                authSession: {
                    clientId: 'operator-client',
                    accessToken: 'operator-token',
                    username: 'alice',
                    sessionId: 'operator-session',
                    expiresAtEpochMs: 100_000,
                },
                issueRunToken: async ({ runId, agentId }) => ({
                    runId,
                    agentId,
                    token: `control-${agentId}`,
                    issuedAtEpochMs: 1_000,
                    expiresAtEpochMs: 60_000,
                }),
                issueAgentTickets: async () => ({ tickets: [{
                    agentId: 'agent-1',
                    ticket: firstTicket,
                    sessionId: firstSession,
                    expiresAtEpochMs: 50_000,
                }, {
                    agentId: 'agent-2',
                    ticket: secondTicket,
                    sessionId: secondSession,
                    expiresAtEpochMs: 50_000,
                }] }),
            });

            await expect(service.prepare({
                runId: 'run-1',
                agentIds: ['agent-1', 'agent-2'],
                group,
            })).rejects.toThrow('unique');
        },
    );

    it('rejects duplicate control-token authority across simulated agents', async () => {
        const service = createBrowserAgentLaunchService({
            origin: 'https://blackbox.example.test',
            providerMode: 'simulated',
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
            issueRunToken: async ({ runId, agentId }) => ({
                runId,
                agentId,
                token: 'shared-control-token',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 60_000,
            }),
        });

        await expect(service.prepare({
            runId: 'run-1',
            agentIds: ['agent-1', 'agent-2'],
            group,
        })).rejects.toThrow('unique');
    });

    it('rejects missing, duplicate, extra, and identity-mismatched launch authority', async () => {
        const base = {
            origin: 'https://blackbox.example.test',
            providerMode: 'simulated' as const,
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
        };
        const mismatched = createBrowserAgentLaunchService({
            ...base,
            issueRunToken: async ({ runId }) => ({
                runId,
                agentId: 'wrong-agent',
                token: 'secret',
                issuedAtEpochMs: 1,
                expiresAtEpochMs: 2,
            }),
        });

        await expect(mismatched.prepare({ runId: 'run-1', agentIds: ['agent-1'], group }))
            .rejects.toThrow('does not match');
        await expect(mismatched.prepare({ runId: '', agentIds: ['agent-1'], group }))
            .rejects.toThrow('Control run ID');
        await expect(mismatched.prepare({ runId: 'run-1', agentIds: [], group }))
            .rejects.toThrow('between 1 and 6');
        await expect(mismatched.prepare({
            runId: 'run-1',
            agentIds: ['agent-1', 'agent-1'],
            group,
        })).rejects.toThrow('unique');

        const invalidExpiry = createBrowserAgentLaunchService({
            ...base,
            issueRunToken: async ({ runId, agentId }) => ({
                runId,
                agentId,
                token: 'secret',
                issuedAtEpochMs: Number.NaN,
                expiresAtEpochMs: 60_000,
            }),
        });
        await expect(invalidExpiry.prepare({
            runId: 'run-1',
            agentIds: ['agent-1'],
            group,
        })).rejects.toThrow('does not match');
    });

    it('rejects invalid browser-rallar ticket expiry metadata', async () => {
        const service = createBrowserAgentLaunchService({
            origin: 'https://blackbox.example.test',
            providerMode: 'browser-rallar',
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
            authSession: {
                clientId: 'operator-client',
                accessToken: 'operator-token',
                username: 'alice',
                sessionId: 'operator-session',
                expiresAtEpochMs: 100_000,
            },
            issueRunToken: async ({ runId, agentId }) => ({
                runId,
                agentId,
                token: 'secret',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 60_000,
            }),
            issueAgentTickets: async () => ({ tickets: [{
                agentId: 'agent-1',
                ticket: 'ticket-1',
                sessionId: 'session-1',
                expiresAtEpochMs: Number.NaN,
            }] }),
        });

        await expect(service.prepare({
            runId: 'run-1',
            agentIds: ['agent-1'],
            group,
        })).rejects.toThrow('valid agent session ticket');
    });

    it('keeps explicit anonymous and interactive-login compatibility at the legacy boundary', async () => {
        const issueAgentTickets = vi.fn();
        const service = createBrowserAgentLaunchService({
            origin: 'https://blackbox.example.test',
            providerMode: 'browser-rallar',
            controlWsUrl: 'wss://control.example.test/control',
            apiBaseUrl: 'https://api.example.test',
            issueAgentSessions: false,
            allowAnonymousControlToken: true,
            issueRunToken: async ({ runId, agentId }) => ({
                runId,
                agentId,
                token: '',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 61_000,
            }),
            issueAgentTickets,
        });

        const result = await service.prepare({
            runId: 'legacy-run',
            agentIds: ['legacy-agent'],
            group,
        });
        const url = new URL(result.agents[0].launchUrl);

        expect(issueAgentTickets).not.toHaveBeenCalled();
        expect(url.searchParams.get('actor')).toBe('legacy-agent');
        expect(url.searchParams.get('sessionId')).toBe('legacy-agent-session');
        expect(url.hash).toBe('');
    });

    it('normalizes an HTTP control base into the compatible control WebSocket endpoint', () => {
        expect(controlWebSocketUrlFromHttpBaseUrl('https://control.example.test/root?token=no'))
            .toBe('wss://control.example.test/control');
        expect(controlWebSocketUrlFromHttpBaseUrl('not-a-url'))
            .toBe('ws://localhost:5180/control');
    });
});

describe('Recipe Console browser-agent launch authority', () => {
    it('does not forward a stored operator session to a URL-selected API origin', async () => {
        const credentialPolicy: RecipeConsoleControlCredentialPolicy = {
            allowManualToken: true,
            allowBrokeredToken: false,
            allowBootstrapAgentTicket: false,
            controlUrlFromLocation: false,
            apiBaseUrlFromLocation: true,
            controlTokenFromLocation: false,
            blockedMessage: 'Automatic credentials are blocked for a URL-configured API endpoint.',
        };
        let observed: RecipeConsoleControlConnection | undefined;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            runs: [],
            distributedRuns: [],
        })));

        function Harness() {
            observed = useControlConnection();
            return null;
        }

        try {
            await act(async () => root.render(createElement(
                ControlConnectionProvider,
                {
                    authSession: {
                        clientId: 'stored-client',
                        accessToken: 'stored-secret',
                        username: 'operator',
                        sessionId: 'stored-session',
                        expiresAtEpochMs: 4_000_000_000_000,
                    },
                    bootstrap: {
                        apiBaseUrl: 'https://untrusted.example.test',
                        providerMode: 'browser-rallar',
                        credentialPolicy,
                        bootstrapGroup: group,
                    },
                },
                createElement(Harness),
            )));

            expect(observed?.browserAgentLaunch).toBeUndefined();
            expect(observed?.browserAgentLaunchIssue).toContain(
                'URL-configured API origin',
            );
        } finally {
            await act(async () => root.unmount());
            container.remove();
            vi.unstubAllGlobals();
        }
    });
});

describe('legacy runner browser-agent launch compatibility', () => {
    it('copies multiple secured agent links that share the legacy run token', async () => {
        const copyText = vi.fn(async () => undefined);
        let message: string | undefined;
        const actions = createRunnerAgentLaunchActions({
            agentRestoreSession: false,
            providerMode: 'simulated',
            apiBaseUrl: 'https://api.example.test',
            agentIds: ['legacy-agent-1', 'legacy-agent-2'],
            agentControlWsUrl: 'wss://control.example.test/control',
            agentRunId: 'legacy-run',
            groupId: group.groupId,
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            controlToken: 'shared-legacy-token',
            copyText,
            setBusyAction: vi.fn(),
            setAgentLaunchMessage: value => {
                message = value;
            },
            setAgentLaunchSuffix: vi.fn(),
            setControlRunId: vi.fn(),
        });

        await actions.copyAgentLinks();

        expect(copyText).toHaveBeenCalledOnce();
        const links = String(copyText.mock.calls[0][0]).split('\n');
        expect(links).toHaveLength(2);
        expect(links.map(link => new URLSearchParams(new URL(link).hash.slice(1))
            .get('controlToken'))).toEqual([
            'shared-legacy-token',
            'shared-legacy-token',
        ]);
        expect(message).toContain('Copied 2 one-time, short-lived agent links.');
    });
});

describe('Recipe Console control agent-launch API', () => {
    it('mints an encoded run-scoped token through the root authorized endpoint', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const endpoint = {
            async response<Value>(operation: (fetchFn: typeof fetch) => Promise<Value>) {
                const value = await operation(async (input, init) => {
                    requests.push({ url: String(input), init });
                    return new Response(JSON.stringify({
                        runId: 'run /1',
                        agentId: 'agent @1',
                        token: 'run-token',
                        issuedAtEpochMs: 1_000,
                        expiresAtEpochMs: 61_000,
                    }), { status: 201 });
                });
                return { value, authorization: 'manual' as const };
            },
        };
        const api = createRecipeConsoleControlAgentLaunchApi({
            baseUrl: 'https://control.example.test/',
            endpoint,
        });

        await expect(api.issueRunToken({
            runId: 'run /1',
            agentId: 'agent @1',
        })).resolves.toMatchObject({ token: 'run-token' });
        expect(requests[0].url).toBe(
            'https://control.example.test/runs/run%20%2F1/agents/agent%20%401/tokens',
        );
        expect(requests[0].init).toMatchObject({
            method: 'POST',
            body: '{}',
        });
    });

    it('rejects invalid or mismatched token payloads before they reach Execute', async () => {
        const endpoint = {
            async response<Value>(operation: (fetchFn: typeof fetch) => Promise<Value>) {
                const value = await operation(async () => new Response(JSON.stringify({
                    runId: 'other-run',
                    agentId: 'agent-1',
                    token: 'run-token',
                    issuedAtEpochMs: 1_000,
                    expiresAtEpochMs: 61_000,
                }), { status: 201 }));
                return { value, authorization: 'anonymous' as const };
            },
        };
        const api = createRecipeConsoleControlAgentLaunchApi({
            baseUrl: 'https://control.example.test',
            endpoint,
        });

        await expect(api.issueRunToken({
            runId: 'run-1',
            agentId: 'agent-1',
        })).rejects.toThrow('does not match');
    });
});

describe('browser-agent popup reservation', () => {
    it('reserves synchronously, reports blocked IDs, and navigates only prepared windows with replace', () => {
        const first = popup();
        const third = popup();
        const open = vi.fn()
            .mockReturnValueOnce(first)
            .mockReturnValueOnce(null)
            .mockReturnValueOnce(third);

        const reservation = reserveBrowserAgentPopups(
            ['agent-1', 'agent-2', 'agent-3'],
            open,
        );

        expect(open).toHaveBeenCalledTimes(3);
        expect(reservation.reservedAgentIds).toEqual(['agent-1', 'agent-3']);
        expect(reservation.blockedAgentIds).toEqual(['agent-2']);
        navigateReservedBrowserAgentPopups(reservation, [{
            agentId: 'agent-1',
            launchUrl: 'https://blackbox.test/agent-1',
        }, {
            agentId: 'agent-3',
            launchUrl: 'https://blackbox.test/agent-3',
        }]);
        expect(first.location.replace).toHaveBeenCalledWith(
            'https://blackbox.test/agent-1',
        );
        expect(third.location.replace).toHaveBeenCalledWith(
            'https://blackbox.test/agent-3',
        );
    });

    it('closes every unused blank window after preparation failure or invalidation', () => {
        const first = popup();
        const second = popup();
        const reservation = reserveBrowserAgentPopups(
            ['agent-1', 'agent-2'],
            vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
        );

        releaseReservedBrowserAgentPopups(reservation, 'Launch cancelled.');

        expect(first.document.body.textContent).toBe('Launch cancelled.');
        expect(second.document.body.textContent).toBe('Launch cancelled.');
        expect(first.close).toHaveBeenCalledOnce();
        expect(second.close).toHaveBeenCalledOnce();
    });

    it('reports a reserved popup closed before prepared links are navigated', () => {
        const first = popup();
        const second = popup();
        const reservation = reserveBrowserAgentPopups(
            ['agent-1', 'agent-2'],
            vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
        );
        second.closed = true;

        const navigation = navigateReservedBrowserAgentPopups(reservation, [{
            agentId: 'agent-1',
            launchUrl: 'https://blackbox.test/agent-1',
        }, {
            agentId: 'agent-2',
            launchUrl: 'https://blackbox.test/agent-2',
        }]);

        expect(navigation).toEqual({
            navigatedAgentIds: ['agent-1'],
            closedAgentIds: ['agent-2'],
        });
        expect(first.location.replace).toHaveBeenCalledOnce();
        expect(second.location.replace).not.toHaveBeenCalled();
    });
});

function popup() {
    return {
        closed: false,
        opener: {} as unknown,
        document: {
            title: '',
            body: { textContent: '' },
        },
        location: { replace: vi.fn() },
        close: vi.fn(),
    };
}

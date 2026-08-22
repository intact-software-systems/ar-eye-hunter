import { describe, expect, it } from 'vitest';
import { runBlackBoxRunnerLivePreflight } from '../../shared-test/black-box-runner/preflight/live-preflight.ts';
import { resolveVariableByEnv } from '../../shared-test/black-box-runner/preflight/resolve-variable-by-env.ts';

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'content-type': 'application/json'
        }
    });
}

describe('black-box runner live preflight variables', () => {
    it('fails closed when fallback variables contain a cycle', () => {
        const value = resolveVariableByEnv(
            {
                variables: {
                    runId: {
                        env: 'RALLAR_BB_RUN_ID',
                        default: '{applicationId}'
                    },
                    applicationId: {
                        env: 'RALLAR_BB_APPLICATION_ID',
                        default: 'api-v1-{runId}'
                    }
                }
            },
            'RALLAR_BB_APPLICATION_ID',
            {}
        );

        expect(value).toBeUndefined();
    });

    it('returns direct environment values verbatim', () => {
        const value = resolveVariableByEnv(
            {
                variables: {
                    applicationId: {
                        env: 'RALLAR_BB_APPLICATION_ID',
                        default: 'fallback'
                    }
                }
            },
            'RALLAR_BB_APPLICATION_ID',
            {
                RALLAR_BB_APPLICATION_ID: 'direct-{runId}'
            }
        );

        expect(value).toBe('direct-{runId}');
    });

    it('resolves nested defaults from an explicit run-id environment value', async () => {
        const requestPaths: string[] = [];
        const report = await runBlackBoxRunnerLivePreflight({
            config: {
                variables: {
                    runId: {
                        env: 'RALLAR_BB_RUN_ID',
                        default: 'local'
                    },
                    applicationId: {
                        env: 'RALLAR_BB_APPLICATION_ID',
                        default: 'api-v1-medium-scale-{runId}'
                    },
                    workspaceId: {
                        env: 'RALLAR_BB_WORKSPACE_ID',
                        default: 'workspace'
                    },
                    groupId: {
                        env: 'RALLAR_BB_GROUP_ID',
                        default: 'group'
                    },
                    aliceUsername: {
                        env: 'RALLAR_ALICE_USERNAME'
                    },
                    alicePassword: {
                        env: 'RALLAR_ALICE_PASSWORD',
                        secret: true
                    }
                },
                steps: [{
                    type: 'http',
                    request: {
                        path: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups'
                    }
                }]
            },
            requires: {
                httpServices: [{
                    name: 'Rallar API',
                    env: 'RALLAR_API_BASE_URL'
                }]
            },
            environment: {
                RALLAR_API_BASE_URL: 'http://rallar.test',
                RALLAR_BB_RUN_ID: 'explicit-run',
                RALLAR_ALICE_USERNAME: 'alice',
                RALLAR_ALICE_PASSWORD: 'secret'
            },
            fetchImplementation: (url, init) => {
                const path = new URL(String(url)).pathname;
                requestPaths.push(path);
                if (path === '/api/config') {
                    return Promise.resolve(jsonResponse({ ok: true }));
                }
                if (path.startsWith('/api/auth/login/requests/')) {
                    return Promise.resolve(jsonResponse({
                        accessToken: 'access-token',
                        clientId: 'alice-client',
                        sessionId: 'alice-session'
                    }));
                }
                if (init?.method === 'POST' && /\/groups\/requests\/[^/]+$/.test(path)) {
                    return Promise.resolve(jsonResponse({ group: { groupId: 'group' } }, 201));
                }
                if (
                    init?.method === 'PUT' &&
                    /\/members\/alice-client\/requests\/[^/]+$/.test(path)
                ) {
                    return Promise.resolve(jsonResponse({ members: [] }));
                }
                throw new Error(`Unexpected preflight request: ${init?.method ?? 'GET'} ${path}`);
            }
        });

        expect(report.ok).toBe(true);
        expect(requestPaths).toEqual(expect.arrayContaining([
            expect.stringMatching(
                new RegExp(
                    '^/api/state/apps/api-v1-medium-scale-explicit-run/' +
                        'workspaces/workspace/groups/requests/[^/]+$'
                )
            )
        ]));
        expect(requestPaths.some((path) => path.includes('%7BrunId%7D'))).toBe(false);
    });

    it('uses a safe preflight scope when nested fallback variables cycle', async () => {
        const requestPaths: string[] = [];
        const report = await runBlackBoxRunnerLivePreflight({
            config: {
                variables: {
                    runId: {
                        env: 'RALLAR_BB_RUN_ID',
                        default: '{runId}'
                    },
                    applicationId: {
                        env: 'RALLAR_BB_APPLICATION_ID',
                        default: 'api-v1-{runId}'
                    },
                    workspaceId: {
                        env: 'RALLAR_BB_WORKSPACE_ID',
                        default: 'workspace'
                    },
                    groupId: {
                        env: 'RALLAR_BB_GROUP_ID',
                        default: 'group'
                    },
                    aliceUsername: {
                        env: 'RALLAR_ALICE_USERNAME'
                    },
                    alicePassword: {
                        env: 'RALLAR_ALICE_PASSWORD',
                        secret: true
                    }
                },
                steps: [{
                    type: 'http',
                    request: {
                        path: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups'
                    }
                }]
            },
            requires: {
                httpServices: [{
                    name: 'Rallar API',
                    env: 'RALLAR_API_BASE_URL'
                }]
            },
            environment: {
                RALLAR_API_BASE_URL: 'http://rallar.test',
                RALLAR_ALICE_USERNAME: 'alice',
                RALLAR_ALICE_PASSWORD: 'secret'
            },
            fetchImplementation: (url, init) => {
                const path = new URL(String(url)).pathname;
                requestPaths.push(path);
                if (path === '/api/config') {
                    return Promise.resolve(jsonResponse({ ok: true }));
                }
                if (path.startsWith('/api/auth/login/requests/')) {
                    return Promise.resolve(jsonResponse({
                        accessToken: 'access-token',
                        clientId: 'alice-client',
                        sessionId: 'alice-session'
                    }));
                }
                if (init?.method === 'POST' && /\/groups\/requests\/[^/]+$/.test(path)) {
                    return Promise.resolve(jsonResponse({ group: { groupId: 'group' } }, 201));
                }
                if (
                    init?.method === 'PUT' &&
                    /\/members\/alice-client\/requests\/[^/]+$/.test(path)
                ) {
                    return Promise.resolve(jsonResponse({ members: [] }));
                }
                throw new Error(`Unexpected preflight request: ${init?.method ?? 'GET'} ${path}`);
            }
        });

        expect(report.ok).toBe(true);
        expect(requestPaths).toEqual(expect.arrayContaining([
            expect.stringMatching(
                new RegExp(
                    '^/api/state/apps/black-box-app/workspaces/workspace/' +
                        'groups/requests/[^/]+$'
                )
            )
        ]));
        expect(requestPaths.some((path) => path.includes('%7BrunId%7D'))).toBe(false);
    });
});

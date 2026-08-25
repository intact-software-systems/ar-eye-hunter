import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { readStateGroupStats, readStateMyRealtimeStatus, readStateWorkspaceStatsSummary } from '@shared-web/browser/stats/rallar-stats-http-api.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Rallar stats HTTP API', () => {
    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
    });

    it('encodes state paths and forwards authentication', async () => {
        const calls: Array<{
            readonly url: string;
            readonly method: string;
            readonly headers: Headers;
        }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                calls.push({
                    url: String(input),
                    method: init?.method ?? 'GET',
                    headers: new Headers(init?.headers)
                });
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            })
        );
        const scope = { applicationId: 'app 1', workspaceId: 'workspace/1' };
        const authSession = {
            clientId: 'alice',
            username: 'alice',
            sessionId: 'alice-session',
            accessToken: 'token-1',
            expiresAtEpochMs: Date.now() + 60_000
        };

        await readStateWorkspaceStatsSummary(scope, { authSession });
        await readStateGroupStats('room /1', scope, { authSession });
        await readStateMyRealtimeStatus(scope, { authSession });

        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/stats/summary',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/stats',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/stats/me/realtime'
        ]);
        expect(calls.every((call) => call.headers.get('authorization') === 'Bearer token-1')).toBe(true);
        expect(calls.every((call) => call.headers.get('x-client-id') === 'alice')).toBe(true);
    });
});

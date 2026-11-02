import { matchmakingHttpApi } from '@shared-web/browser/matchmaking/matchmaking-http-api.ts';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
afterEach(() => vi.unstubAllGlobals());

it('sends scoped authenticated commands with the same request identity on transport retry and decodes private recovery', async () => {
    const scope = { applicationId: 'game', workspaceId: 'default' };
    const session = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
    const signal = new AbortController().signal;
    const result = { scope, principalId: 'alice', requestId: 'matchmaking-request-0001', status: 'applied', searchId: 'search-1', code: null };
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    fetch.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValueOnce(Response.json(result));
    await expect(matchmakingHttpApi.change({ scope, session, signal, requestId: result.requestId, request: { action: 'start', searchId: 'search-1' } }))
        .resolves.toEqual(result);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        'http://api.test/api/matchmaking/apps/game/workspaces/default/requests/matchmaking-request-0001',
        'http://api.test/api/matchmaking/apps/game/workspaces/default/requests/matchmaking-request-0001'
    ]);
    for (const [, options] of fetch.mock.calls) {
        expect(JSON.parse(String(options?.body))).toEqual({ action: 'start', searchId: 'search-1' });
        expect(new Headers(options?.headers).get('x-client-id')).toBe('alice');
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    }
    const snapshot = { scope, principalId: 'alice', observedAtEpochMs: 1, state: { status: 'searching', searchId: 'search-1', expiresAtEpochMs: 120001 } };
    fetch.mockResolvedValueOnce(Response.json(snapshot));
    await expect(matchmakingHttpApi.read({ scope, session, signal })).resolves.toEqual(snapshot);
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('http://api.test/api/matchmaking/apps/game/workspaces/default');
    fetch.mockResolvedValueOnce(Response.json({ ...snapshot, leakedSessionId: 'private' }));
    await expect(matchmakingHttpApi.read({ scope, session, signal })).rejects.toThrow();
});

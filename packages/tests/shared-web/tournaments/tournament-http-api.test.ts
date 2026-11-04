import { tournamentHttpApi } from '@shared-web/browser/tournaments/tournament-http-api.ts';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
afterEach(() => vi.unstubAllGlobals());

it('replays the exact authenticated scoped intent after a lost response and rejects a substituted result', async () => {
    const scope = { applicationId: 'game', workspaceId: 'default' };
    const ref = { ...scope, tournamentId: 'cup' };
    const session = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
    const signal = new AbortController().signal;
    const result = { ref, requestId: 'tournament-request-0001', status: 'applied', code: null };
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    fetch.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValueOnce(Response.json(result));
    const input = { scope, ref, session, signal, requestId: result.requestId, request: { type: 'register' as const } };
    await expect(tournamentHttpApi.change(input)).resolves.toEqual(result);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
        Array(2).fill('http://api.test/api/tournaments/apps/game/workspaces/default/tournaments/cup/requests/tournament-request-0001')
    );
    for (const [, options] of fetch.mock.calls) {
        expect(JSON.parse(String(options?.body))).toEqual({ type: 'register' });
        expect(new Headers(options?.headers).get('x-client-id')).toBe('alice');
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    }
    fetch.mockImplementation(async () => Response.json({ ...result, ref: { ...ref, tournamentId: 'other' } }));
    await expect(tournamentHttpApi.change(input)).rejects.toThrow('Tournament result differs');
});

import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { readAdminRoomDirectory } from '@shared-web/browser/admin-rooms/admin-room-http-api.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';

const scope = { applicationId: 'ar-eye-hunter', workspaceId: 'test:rooms' };
const session = { clientId: 'admin', username: 'operator', sessionId: 'admin-session', accessToken: 'test-only', expiresAtEpochMs: 30_000 };
const response = { scope, observedAtEpochMs: 10_000, completeness: 'complete', entries: [], nextAfterGroupId: 'b-room' };

afterEach(() => vi.unstubAllGlobals());

it('sends the explicit API identity, encoded scope and cursor, and decodes the bounded response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(readAdminRoomDirectory({
        apiBaseUrl: 'https://api.example.test/',
        scope,
        limit: 20,
        afterGroupId: 'a:room',
        session,
        signal
    })).resolves.toEqual(response);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/admin/operations/rooms/apps/ar-eye-hunter/workspaces/test%3Arooms?limit=20&afterGroupId=a%3Aroom');
    expect(options?.method).toBe('GET');
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    expect(new Headers(options?.headers).get('x-client-id')).toBe('admin');
    expect(options?.signal).toBe(signal);
});

it('preserves authorization failures and never substitutes stored credentials for a missing API session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(readAdminRoomDirectory({
        apiBaseUrl: 'https://api.example.test',
        scope,
        limit: 20,
        afterGroupId: null,
        session: null,
        signal: new AbortController().signal
    })).rejects.toBeInstanceOf(ApiHttpError);
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-client-id')).toBe(false);
});

it('rejects a response from another workspace instead of presenting its rooms', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
            ...response,
            scope: { ...scope, workspaceId: 'foreign' }
        }))
    );
    await expect(readAdminRoomDirectory({
        apiBaseUrl: 'https://api.example.test',
        scope,
        limit: 20,
        afterGroupId: null,
        session,
        signal: new AbortController().signal
    })).rejects.toThrow('foreign scope');
});

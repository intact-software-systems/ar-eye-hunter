import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { listStateGroupDirectory } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const DIRECTORY_URL = 'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/group-directory';

describe('browser group directory request', () => {
    beforeEach(() => {
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends only the filters the caller set', async () => {
        const page = { entries: [], nextCursor: null };
        const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
            new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(listStateGroupDirectory(scope, {}, { authSession: null })).resolves.toEqual(page);
        await expect(listStateGroupDirectory(scope, {
            kind: 'room',
            q: 'eye hunter',
            limit: 20,
            cursor: 'abc',
            includeEmpty: true,
            order: 'peer-rtt'
        }, { authSession: null })).resolves.toEqual(page);

        expect(fetchMock.mock.calls[0]?.[0]).toBe(DIRECTORY_URL);
        expect(fetchMock.mock.calls[1]?.[0]).toBe(
            `${DIRECTORY_URL}?kind=room&q=eye+hunter&limit=20&cursor=abc&includeEmpty=true&order=peer-rtt`
        );
    });
});

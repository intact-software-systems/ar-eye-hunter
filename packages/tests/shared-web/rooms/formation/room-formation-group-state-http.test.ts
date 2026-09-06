import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';

import { createRoomSnapshot, resetRoomWorkflowTestRuntime } from '../room-workflow-test-runtime.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('room formation group-state HTTP port', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('posts a lifecycle command under its request-id path and returns the receipt snapshot', async () => {
        const { roomGroupStateHttpApi } = await import('@shared-web/browser/rooms/room-group-state-http-api.ts');
        const receipt = createRoomSnapshot('room-1', ['session-1']);
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } })
        );
        vi.stubGlobal('fetch', fetchMock);

        const snapshot = await roomGroupStateHttpApi.commandLifecycle({
            groupId: 'room-1',
            request: {
                command: 'connect',
                body: {
                    expectedFormationEpoch: 1,
                    expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
                }
            },
            options: { requestId: 'connect-request-0001-a1b2' },
            scope
        });

        expect(snapshot).toEqual(receipt);
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe(
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/lifecycle/connect/requests/connect-request-0001-a1b2'
        );
        expect(init?.method).toBe('POST');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(headers.get('x-client-id')).toBe('principal-1');
        expect(JSON.parse(String(init?.body))).toEqual({
            expectedFormationEpoch: 1,
            expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
        });
    });
});

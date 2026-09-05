import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';

import { createRoomSnapshot, resetRoomWorkflowTestRuntime } from '../room-workflow-test-runtime.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('room formation HTTP API', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('posts a lifecycle command under the request-id path and returns the receipt snapshot', async () => {
        const { roomFormationHttpApi } = await import('@shared-web/browser/rooms/formation/room-formation-http-api.ts');
        const receipt = createRoomSnapshot('room-1', ['session-1']);
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        const snapshot = await roomFormationHttpApi.command({
            groupId: 'room-1',
            command: 'connect',
            request: {
                actorPrincipalId: 'principal-1',
                actorSessionId: 'session-1',
                expectedFormationEpoch: 1,
                expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
            },
            options: { requestId: 'connect-request-0001-a1b2' },
            scope
        });

        expect(snapshot).toEqual(receipt);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/lifecycle/connect/requests/connect-request-0001-a1b2'
        );
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init?.method).toBe('POST');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(headers.get('x-client-id')).toBe('principal-1');
        expect(JSON.parse(String(init?.body))).toEqual({
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
            expectedFormationEpoch: 1,
            expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
        });
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';

import { installFakeBroadcastChannelPerTest } from '../../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, resetRoomWorkflowTestRuntime } from '../room-workflow-test-runtime.ts';

interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly body: object;
}

const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'granted-room' };
const requests: HttpRequest[] = [];

installFakeBroadcastChannelPerTest();

describe('room topic grants through the browser facade', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
        requests.length = 0;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('grantTopic posts to /publication-grants/{principalId}/grant/requests/{id} and stores the returned snapshot', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createRoomSnapshot('granted-room', ['session-1']);
        respond(() => json(snapshot));
        const facade = createRallarFacade();

        await expect(
            facade.rooms.grantTopic(
                { room: roomRef, principalId: 'reader-1', options: { reason: 'Reads the feed' } },
                'room.feed',
                { publish: false, subscribe: true }
            )
        ).resolves.toEqual(snapshot);

        expect(requests).toEqual([{
            url: expect.stringMatching(
                /^\/api\/state\/apps\/app-1\/workspaces\/workspace-1\/groups\/granted-room\/publication-grants\/reader-1\/grant\/requests\/[\w-]{20,}$/
            ),
            method: 'POST',
            body: {
                topicId: 'room.feed',
                publish: false,
                subscribe: true,
                reason: 'Reads the feed',
                actorPrincipalId: 'principal-1',
                actorSessionId: 'session-1'
            }
        }]);
        expect(facade.rooms.state().rooms.find((room) => room.roomId === 'granted-room')?.snapshot).toEqual(snapshot);
    });

    it('revokeTopic revokes both permissions', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond(() => json(createRoomSnapshot('granted-room', ['session-1'])));

        await createRallarFacade().rooms.revokeTopic({ room: roomRef, principalId: 'reader-1' }, 'room.feed');

        expect(requests).toEqual([{
            url: expect.stringMatching(/\/groups\/granted-room\/publication-grants\/reader-1\/revoke\/requests\/[\w-]{20,}$/),
            method: 'POST',
            body: {
                topicId: 'room.feed',
                publish: true,
                subscribe: true,
                actorPrincipalId: 'principal-1',
                actorSessionId: 'session-1'
            }
        }]);
    });

    it('a 403 surfaces as ApiHttpError', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond(() => new Response(JSON.stringify({ error: 'denied', code: 'forbidden-role' }), { status: 403 }));

        const granting = createRallarFacade().rooms.grantTopic(
            { room: roomRef, principalId: 'reader-1' },
            'room.feed',
            { publish: true, subscribe: true }
        );

        await expect(granting).rejects.toBeInstanceOf(ApiHttpError);
        await expect(granting).rejects.toMatchObject({ status: 403, policyError: { code: 'forbidden-role' } });
        expect(requests).toHaveLength(1);
    });
});

function respond(handler: (request: HttpRequest) => Response): void {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request: HttpRequest = { url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) };
        requests.push(request);
        return handler(request);
    });
}

function json(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

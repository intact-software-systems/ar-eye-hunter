import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from './room-workflow-test-runtime.ts';

interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly body: object;
    readonly clientId: string | null;
}

const runtime = getRoomWorkflowMocks();
const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const requests: HttpRequest[] = [];

installFakeBroadcastChannelPerTest();

describe('room entry through the browser facade and HTTP workflow', () => {
    beforeEach(async () => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
        requests.length = 0;
        const actual = await vi.importActual<typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts')>(
            '@shared-web/browser/rooms/room-group-state-workflows.ts'
        );
        runtime.joinStateGroup.mockImplementation(actual.joinStateGroup);
        runtime.leaveStateGroup.mockImplementation(actual.leaveStateGroup);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('resolves object targets and passes credentials to the exact scoped admission endpoint', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond((request) => json(createRoomSnapshot(request.url.includes('/room-ref/') ? 'room-ref' : 'room-id', ['session-1'])));
        const facade = createRallarFacade();
        facade.setDefaults(scope);

        await facade.rooms.join({ roomId: 'room-id', leaveCurrent: false });
        await facade.rooms.join({
            roomRef: { ...scope, groupId: 'room-ref' },
            inviteToken: 'invite-1',
            joinCode: 'code-1',
            leaveCurrent: false
        });

        expect(requests).toHaveLength(4);
        expect(requests[0].url).toMatch(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/room-id\/join\/requests\//);
        expect(requests[2]).toMatchObject({
            method: 'POST',
            body: { inviteToken: 'invite-1', joinCode: 'code-1', actorPrincipalId: 'principal-1', actorSessionId: 'session-1' }
        });
        expect(requests[2].url).toMatch(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/room-ref\/join\/requests\//);
        expect(facade.rooms.current()?.group.groupId).toBe('room-ref');
    });

    it('sends explicit watch and play intent while ordinary recovery leaves participation unchanged', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond(() => json(createRoomSnapshot('watched', ['session-1'])));
        const facade = createRallarFacade();
        const roomRef = { ...scope, groupId: 'watched' };
        await facade.rooms.watch({ roomRef, participation: 'player' }, { leaveCurrent: false });
        await facade.rooms.join(roomRef, { participation: 'player', leaveCurrent: false });
        await facade.rooms.join(roomRef, { leaveCurrent: false });
        expect(requests.filter(isAdmission).map((request) => request.body)).toEqual([
            { participation: 'spectator', actorPrincipalId: 'principal-1', actorSessionId: 'session-1' },
            { participation: 'player', actorPrincipalId: 'principal-1', actorSessionId: 'session-1' },
            { actorPrincipalId: 'principal-1', actorSessionId: 'session-1' }
        ]);
    });

    it.each([503, 429, 400, 409])('applies the HTTP retry policy to status %s', async (status) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const connected = createRoomSnapshot('selected', ['session-1']);
        respond(() => requests.length === 1 ? new Response('failed', { status }) : json(connected));
        const pending = createRallarFacade().rooms.join('selected', { scope, maxAttempts: 2 });

        if (status === 503 || status === 429) {
            await expect(pending).resolves.toEqual(connected);
            expect(requests).toHaveLength(3);
            expect(requests[0].url).toBe(requests[1].url);
        }
        else {
            await expect(pending).rejects.toMatchObject({ status });
            expect(requests).toHaveLength(1);
        }
    });

    it('retains admitted membership when presence fails and preserves the previous current room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const admitted = createRoomSnapshot('selected', []);
        seedRoomSnapshots([previous]);
        respond((request) => isAdmission(request) ? json(admitted) : new Response('failed', { status: 503 }));
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            joinedRoom: admitted,
            cause: { status: 503 }
        });

        expect(requests).toHaveLength(2);
        expect(facade.rooms.current()).toBe(previous);
    });

    it.each(
        [
            { stage: 'admission', sessionId: 'other-session' },
            { stage: 'presence', sessionId: 'other-session' },
            { stage: 'admission', sessionId: 'session-1' }
        ] as const
    )('cannot adopt or leave after auth changes during $stage to $sessionId', async ({ stage, sessionId }) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const admitted = createRoomSnapshot('selected', []);
        seedRoomSnapshots([previous]);
        respond((request) => {
            if (isAdmission(request) === (stage === 'admission')) {
                runtime.readSession.mockReturnValue({ ...runtime.session, clientId: 'other-principal', sessionId });
            }
            return json(isAdmission(request) ? admitted : createRoomSnapshot('selected', ['session-1']));
        });
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            joinedRoom: admitted
        });

        expect(requests).toHaveLength(stage === 'admission' ? 1 : 2);
        expect(requests.every((request) => request.clientId === runtime.session.clientId)).toBe(true);
        expect(facade.rooms.current()?.group.groupId).not.toBe('selected');
    });

    it.each([401, 403])('handles auth status %s beneath a partial-admission failure', async (status) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const admitted = createRoomSnapshot('selected', []);
        const authStates: RallarAuthState[] = [];
        respond((request) => isAdmission(request) ? json(admitted) : new Response('denied', { status }));
        const facade = createRallarFacade();
        facade.auth.onChange((state) => {
            authStates.push(state);
        });

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            joinedRoom: admitted,
            cause: { status }
        });

        expect(authStates.at(-1)?.authenticated).toBe(status !== 401);
        expect(authStates.filter((state) => state.reason === 'unauthorized')).toHaveLength(status === 401 ? 1 : 0);
    });

    it.each(['admission', 'presence'] as const)('cannot adopt or leave after cancellation during %s', async (stage) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous]);
        const controller = new AbortController();
        respond((request) => {
            if (isAdmission(request) === (stage === 'admission')) {
                controller.abort();
            }
            return json(createRoomSnapshot('selected', ['session-1']));
        });
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope, signal: controller.signal })).rejects.toBeInstanceOf(Error);

        expect(requests).toHaveLength(stage === 'admission' ? 1 : 2);
        expect(facade.rooms.current()).toBe(previous);
    });

    it('leaves the previous room only after the destination becomes current', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const connected = createRoomSnapshot('selected', ['session-1']);
        seedRoomSnapshots([previous]);
        const facade = createRallarFacade();
        const currentWhenLeaving: (GroupSnapshot | undefined)[] = [];
        respond((request) => {
            if (request.url.includes('/previous/')) {
                currentWhenLeaving.push(facade.rooms.current());
                return json(createRoomSnapshot('previous', []));
            }
            return json(connected);
        });

        await expect(facade.rooms.join('selected', { scope })).resolves.toEqual(connected);

        expect(currentWhenLeaving).toEqual([connected, connected]);
        expect(facade.rooms.current()).toEqual(connected);
        expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'POST', 'PUT']);
    });

    it('reports failed previous-room cleanup while keeping the joined room current', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const connected = createRoomSnapshot('selected', ['session-1']);
        seedRoomSnapshots([previous]);
        respond((request) => request.url.includes('/previous/') ? new Response('failed', { status: 503 }) : json(connected));
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'join',
            joinedRoom: connected,
            previousRoomRef: previous.group,
            leaveError: { status: 503 }
        });

        expect(facade.rooms.current()).toEqual(connected);
        expect(facade.rooms.state().currentRoomRef).toEqual(connected.group);
    });

    it('preserves the current room when admission is denied', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous]);
        respond(() => new Response('denied', { status: 403 }));
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({ status: 403 });

        expect(requests).toHaveLength(1);
        expect(facade.rooms.current()).toBe(previous);
    });

    it('rejects a mismatched room target before any request', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond(() => {
            throw new Error('Unexpected request');
        });

        await expect(createRallarFacade().rooms.join({ roomId: 'room-a', roomRef: { ...scope, groupId: 'room-b' } }))
            .rejects.toThrow('roomId must match roomRef.groupId');

        expect(requests).toEqual([]);
    });
});

function respond(handler: (request: HttpRequest) => Response): void {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = {
            url: String(url),
            method: init?.method ?? 'GET',
            body: JSON.parse(String(init?.body ?? '{}')),
            clientId: new Headers(init?.headers).get('x-client-id')
        };
        requests.push(request);
        return handler(request);
    });
}

function isAdmission(request: HttpRequest): boolean {
    return request.url.includes('/join/requests/');
}

function json(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

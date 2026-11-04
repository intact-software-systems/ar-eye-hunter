import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { requireEpoch, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
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
        respond((request) =>
            createJsonResponse(applyPresenceRequest(createRoomSnapshot(request.url.includes('/room-ref/') ? 'room-ref' : 'room-id', ['session-1']), request))
        );
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
        let watched = createRoomSnapshot('watched', ['session-1']);
        respond((request) => {
            watched = applyPresenceRequest(watched, request);
            if (request.method === 'PUT') {
                watched = {
                    ...watched,
                    causalRevision: { ...watched.causalRevision, presenceRevision: watched.causalRevision.presenceRevision + 1 },
                    group: { ...watched.group, presenceVersion: watched.group.presenceVersion + 1 }
                };
            }
            return createJsonResponse(watched);
        });
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
        let connected = createRoomSnapshot('selected', ['session-1']);
        respond((request) => {
            if (requests.length === 1) {
                return new Response('failed', { status });
            }
            connected = applyPresenceRequest(connected, request);
            return createJsonResponse(connected);
        });
        const pending = createRallarFacade().rooms.join('selected', { scope, maxAttempts: 2 });

        if (status === 503 || status === 429) {
            expect(await pending).toEqual(connected);
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
        respond((request) => isAdmission(request) ? createJsonResponse(admitted) : new Response('failed', { status: 503 }));
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            joinedRoom: admitted,
            cause: { status: 503 }
        });

        expect(requests).toHaveLength(2);
        expect(facade.rooms.current()).toBe(previous);
    });

    it.each(['incomparable', 'same-revision'] as const)(
        'recovers a conflicting %s admission response through a current scoped read before selecting the room',
        async (conflict) => {
            const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
            const previous = createRoomSnapshot('previous', ['session-1']);
            const cached = createRoomAtRevision(conflict === 'incomparable' ? 4 : 5, 5);
            const response = createRoomAtRevision(5, conflict === 'incomparable' ? 4 : 5);
            let delayed = { ...response, group: { ...response.group, displayName: 'Outdated room name' } };
            let current = createRoomAtRevision(5, 5);
            seedRoomSnapshots([previous, cached]);
            const facade = createRallarFacade();
            respond((request) => {
                if (request.method === 'GET') {
                    expect(facade.rooms.current()).toBe(previous);
                    current = { ...current, activeSessions: delayed.activeSessions };
                    return createPointReadResponse(current);
                }
                delayed = applyPresenceRequest(delayed, request);
                return createJsonResponse(delayed);
            });

            expect(await facade.rooms.join('selected', { scope, leaveCurrent: false })).toEqual(current);

            expect(facade.rooms.current()).toEqual(current);
            expect(requests.filter(isAdmission)).toHaveLength(1);
            expect(requests.filter((request) => request.method === 'GET')).toMatchObject([{
                url: '/api/state/apps/app-1/workspaces/workspace-1/groups/selected?minGroupRevision=5&minPresenceRevision=5',
                clientId: runtime.session.clientId
            }]);
        }
    );

    it('keeps the previous room selected when recovering an admitted room fails', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const cached = createRoomAtRevision(4, 5);
        let delayed = createRoomAtRevision(5, 4);
        seedRoomSnapshots([previous, cached]);
        const facade = createRallarFacade();
        respond((request) => {
            if (request.method === 'GET') {
                return new Response('unavailable', { status: 503 });
            }
            delayed = applyPresenceRequest(delayed, request);
            return createJsonResponse(delayed);
        });

        const rejected = facade.rooms.join('selected', { scope });
        await expect(rejected).rejects.toBeInstanceOf(Error);
        await expect(rejected).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            joinedRoom: delayed,
            cause: { status: 503 }
        });

        expect(facade.rooms.current()).toBe(previous);
        expect(requests.filter(isAdmission)).toHaveLength(1);
        expect(requests.some((request) => request.url.includes('/previous/'))).toBe(false);
    });

    it.each(['cancelled', 'replaced account'] as const)(
        'does not adopt a recovery read after the entry is %s',
        async (interruption) => {
            const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
            const previous = createRoomSnapshot('previous', ['session-1']);
            const cached = createRoomAtRevision(4, 5);
            let delayed = createRoomAtRevision(5, 4);
            seedRoomSnapshots([previous, cached]);
            const controller = new AbortController();
            const facade = createRallarFacade();
            respond((request) => {
                if (request.method === 'GET') {
                    if (interruption === 'cancelled') {
                        controller.abort();
                    }
                    else {
                        runtime.readSession.mockReturnValue({ ...runtime.session, clientId: 'replacement' });
                    }
                    return createPointReadResponse(createRoomAtRevision(5, 5));
                }
                delayed = applyPresenceRequest(delayed, request);
                return createJsonResponse(delayed);
            });

            const rejected = facade.rooms.join('selected', { scope, signal: controller.signal });
            await expect(rejected).rejects.toBeInstanceOf(Error);
            await expect(rejected).rejects.toMatchObject({
                name: 'RallarRoomJoinPartialFailureError',
                joinedRoom: delayed
            });

            expect(facade.rooms.current()).toBe(previous);
            expect(requests.filter(isAdmission)).toHaveLength(1);
            expect(requests.some((request) => request.url.includes('/previous/'))).toBe(false);
        }
    );

    it('rejects a recovery read below either observed revision floor', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous, createRoomAtRevision(4, 5)]);
        let delayed = createRoomAtRevision(5, 4);
        const facade = createRallarFacade();
        respond((request) => {
            if (request.method === 'GET') {
                return createPointReadResponse(delayed);
            }
            delayed = applyPresenceRequest(delayed, request);
            return createJsonResponse(delayed);
        });

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            cause: { message: 'Current room read does not cover the admitted and observed revisions.' }
        });

        expect(facade.rooms.current()).toBe(previous);
        expect(requests.filter(isAdmission)).toHaveLength(1);
    });

    it.each([10, undefined])('bounds recovery reads with timeout %s and cannot select after a late response', async (timeoutMs) => {
        vi.useFakeTimers();
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous, createRoomAtRevision(4, 5)]);
        const readStarted = Promise.withResolvers<void>();
        const read = Promise.withResolvers<Response>();
        respond((request) => {
            if (request.method === 'GET') {
                readStarted.resolve();
                return read.promise;
            }
            return createJsonResponse(applyPresenceRequest(createRoomAtRevision(5, 4), request));
        });
        const facade = createRallarFacade();
        const failure = expect(facade.rooms.join('selected', { scope, timeoutMs })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            cause: { name: 'CommandTimedOutError' }
        });
        await readStarted.promise;
        await vi.advanceTimersByTimeAsync(timeoutMs ?? 15000);
        await failure;
        read.resolve(createPointReadResponse(createRoomAtRevision(5, 5)));
        await vi.advanceTimersByTimeAsync(0);

        expect(facade.rooms.current()).toBe(previous);
        expect(requests.filter(isAdmission)).toHaveLength(1);
    });

    it('does not hide an unrelated hydration failure behind a recovery read', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous]);
        const cause = new Error('RTC observer failed');
        runtime.hydrateStateCache.mockRejectedValueOnce(cause);
        respond((request) => createJsonResponse(applyPresenceRequest(createRoomAtRevision(5, 5), request)));
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            cause
        });

        expect(facade.rooms.current()).toBe(previous);
        expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT']);
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
            return createJsonResponse(isAdmission(request) ? admitted : createRoomSnapshot('selected', ['session-1']));
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
        respond((request) => isAdmission(request) ? createJsonResponse(admitted) : new Response('denied', { status }));
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
            return createJsonResponse(createRoomSnapshot('selected', ['session-1']));
        });
        const facade = createRallarFacade();

        await expect(facade.rooms.join('selected', { scope, signal: controller.signal })).rejects.toBeInstanceOf(Error);

        expect(requests).toHaveLength(stage === 'admission' ? 1 : 2);
        expect(facade.rooms.current()).toBe(previous);
    });

    it('leaves the previous room only after the destination becomes current', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        let connected = createRoomSnapshot('selected', ['session-1']);
        seedRoomSnapshots([previous]);
        const facade = createRallarFacade();
        const currentWhenLeaving: (GroupSnapshot | undefined)[] = [];
        respond((request) => {
            if (request.url.includes('/previous/')) {
                currentWhenLeaving.push(facade.rooms.current());
                return createJsonResponse(createRoomSnapshot('previous', []));
            }
            connected = applyPresenceRequest(connected, request);
            return createJsonResponse(connected);
        });

        expect(await facade.rooms.join('selected', { scope })).toEqual(connected);

        expect(currentWhenLeaving).toEqual([connected, connected]);
        expect(facade.rooms.current()).toEqual(connected);
        expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'POST', 'PUT']);
    });

    it('switches presence while preserving the previous owner membership when requested', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        let connected = createRoomSnapshot('selected', ['session-1']);
        const departed = {
            ...previous,
            activeSessions: [],
            onlineMemberCount: 0,
            group: { ...previous.group, presenceVersion: previous.group.presenceVersion + 1 },
            causalRevision: { ...previous.causalRevision, presenceRevision: previous.causalRevision.presenceRevision + 1 }
        };
        seedRoomSnapshots([previous]);
        respond((request) => {
            if (request.url.includes('/previous/')) {
                return createJsonResponse(departed);
            }
            connected = applyPresenceRequest(connected, request);
            return createJsonResponse(connected);
        });
        const facade = createRallarFacade();
        const selectedRooms: (string | undefined)[] = [];
        const unsubscribe = facade.rooms.onChange((state) => {
            selectedRooms.push(state.currentRoomRef?.groupId);
        });
        expect(await facade.rooms.join('selected', { scope, preserveCurrentMembership: true })).toEqual(connected);
        expect(requests.filter((request) => request.url.includes('/previous/'))).toEqual([expect.objectContaining({
            url: expect.stringMatching(/\/previous\/sessions\/session-1\/disconnect\/requests\//),
            method: 'POST'
        })]);
        const retained = facade.rooms.session(previous.group).snapshot();
        expect(retained?.members).toEqual(previous.members);
        expect(retained?.activeSessions).toEqual([]);
        expect(facade.rooms.current()).toEqual(connected);
        expect(selectedRooms.filter((room, index) => index === 0 || room !== selectedRooms[index - 1]))
            .toEqual(['previous', 'selected']);
        unsubscribe();
    });

    it.each([
        { summary: 'empty', preserveCurrentMembership: false },
        { summary: 'empty', preserveCurrentMembership: true },
        { summary: 'another-generation', preserveCurrentMembership: true }
    ])(
        'confirms $summary destination presence before handoff with preserveCurrentMembership=$preserveCurrentMembership',
        async ({ summary, preserveCurrentMembership }) => {
            const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
            const previous = createRoomSnapshot('previous', ['session-1']);
            const pendingBase = createRoomSnapshot('selected', summary === 'empty' ? [] : ['session-1']);
            const pending = {
                ...pendingBase,
                activeSessions: pendingBase.activeSessions.map((presence) => ({
                    ...presence,
                    expiresAtEpochMs: Date.now() + 120_000
                }))
            };
            const arrived = createRoomSnapshot('selected', ['session-1']);
            seedRoomSnapshots([previous]);
            const facade = createRallarFacade();
            const selectedRooms: (string | undefined)[] = [];
            const unsubscribe = facade.rooms.onChange((state) => {
                selectedRooms.push(state.currentRoomRef?.groupId);
            });
            let generationId = '';
            let confirmed = false;
            respond((request) => {
                if (request.url.includes('/previous/')) {
                    expect(confirmed).toBe(true);
                    return createJsonResponse({
                        ...previous,
                        group: { ...previous.group, presenceVersion: 2 },
                        causalRevision: { ...previous.causalRevision, presenceRevision: 2 },
                        activeSessions: [],
                        onlineMemberCount: 0
                    });
                }
                if (request.method === 'PUT') {
                    const requested = requireRecord(request.body, 'Presence request').generationId;
                    requireString(requested, 'generationId');
                    generationId = requested;
                }
                if (request.method === 'GET') {
                    confirmed = true;
                    return createPointReadResponse({
                        ...arrived,
                        activeSessions: arrived.activeSessions.map((presence) => ({
                            ...presence,
                            generationId,
                            expiresAtEpochMs: Date.now() + 120_000
                        }))
                    });
                }
                return createJsonResponse(pending);
            });

            await facade.rooms.join('selected', { scope, preserveCurrentMembership });

            expect(confirmed).toBe(true);
            expect(facade.rooms.current()?.activeSessions[0]).toMatchObject({ generationId, sessionId: 'session-1' });
            expect(selectedRooms.filter((room, index) => index === 0 || room !== selectedRooms[index - 1]))
                .toEqual(['previous', 'selected']);
            unsubscribe();
        }
    );

    it('retains source selection and admitted destination details when arrival confirmation fails', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const pending = createRoomSnapshot('selected', []);
        seedRoomSnapshots([previous]);
        const facade = createRallarFacade();
        respond((request) => request.method === 'GET' ? new Response('Unavailable', { status: 503 }) : createJsonResponse(pending));

        await expect(facade.rooms.join('selected', { scope, preserveCurrentMembership: true, maxAttempts: 1 }))
            .rejects.toMatchObject({ name: 'RallarRoomJoinPartialFailureError', joinedRoom: pending, cause: { status: 503 } });

        expect(facade.rooms.current()).toBe(previous);
        expect(requests.some((request) => request.url.includes('/previous/'))).toBe(false);
    });

    it('can retry a failed presence-only departure without forgetting the source room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        let connected = createRoomSnapshot('selected', ['session-1']);
        const departed = {
            ...previous,
            activeSessions: [],
            onlineMemberCount: 0,
            group: { ...previous.group, presenceVersion: previous.group.presenceVersion + 1 },
            causalRevision: {
                ...previous.causalRevision,
                presenceRevision: previous.causalRevision.presenceRevision + 1
            }
        };
        seedRoomSnapshots([previous]);
        let failDeparture = true;
        respond((request) => {
            if (request.url.includes('/previous/')) {
                return failDeparture ? new Response('unavailable', { status: 503 }) : createJsonResponse(departed);
            }
            connected = applyPresenceRequest(connected, request);
            return createJsonResponse(connected);
        });
        const facade = createRallarFacade();
        const rejected = facade.rooms.join('selected', { scope, preserveCurrentMembership: true, maxAttempts: 1 });
        await expect(rejected).rejects.toBeInstanceOf(Error);
        await expect(rejected).rejects
            .toMatchObject({ name: 'RallarRoomJoinPartialFailureError', joinedRoom: connected });
        expect(facade.rooms.current()).toEqual(previous);
        failDeparture = false;
        expect(await facade.rooms.join('selected', { scope, preserveCurrentMembership: true })).toEqual(connected);
        expect(facade.rooms.session(previous.group).snapshot()?.activeSessions).toEqual([]);
        expect(facade.rooms.current()).toEqual(connected);
    });

    it('reports failed previous-room cleanup while keeping the joined room current', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        let connected = createRoomSnapshot('selected', ['session-1']);
        seedRoomSnapshots([previous]);
        respond((request) => {
            if (request.url.includes('/previous/')) {
                return new Response('failed', { status: 503 });
            }
            connected = applyPresenceRequest(connected, request);
            return createJsonResponse(connected);
        });
        const facade = createRallarFacade();

        const rejected = facade.rooms.join('selected', { scope });
        await expect(rejected).rejects.toBeInstanceOf(Error);
        await expect(rejected).rejects.toMatchObject({
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

function respond(handler: (request: HttpRequest) => Response | Promise<Response>): void {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = {
            url: String(url),
            method: init?.method ?? 'GET',
            body: requireRecord(JSON.parse(String(init?.body ?? '{}')), 'Room request'),
            clientId: new Headers(init?.headers).get('x-client-id')
        };
        requests.push(request);
        return handler(request);
    });
}

function isAdmission(request: HttpRequest): boolean {
    return request.url.includes('/join/requests/');
}

function createJsonResponse(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function createRoomAtRevision(groupRevision: number, presenceRevision: number): GroupSnapshot {
    const snapshot = createRoomSnapshot('selected', ['session-1']);
    return {
        ...snapshot,
        causalRevision: { groupRevision, presenceRevision },
        group: { ...snapshot.group, snapshotVersion: groupRevision, presenceVersion: presenceRevision }
    };
}

function createPointReadResponse(snapshot: GroupSnapshot): Response {
    return new Response(JSON.stringify(snapshot), {
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(snapshot.causalRevision.groupRevision),
            'rallar-presence-revision': String(snapshot.causalRevision.presenceRevision)
        }
    });
}

/** The fixture server publishes the generation and lease from a successful presence command. */
function applyPresenceRequest(snapshot: GroupSnapshot, request: HttpRequest): GroupSnapshot {
    if (request.method !== 'PUT') {
        return snapshot;
    }
    const body = requireRecord(request.body, 'Presence request');
    const generationId = body.generationId;
    requireString(generationId, 'generationId');
    const expiresAtEpochMs = body.expiresAtEpochMs;
    requireEpoch(expiresAtEpochMs, 'expiresAtEpochMs');
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((presence) => ({
            ...presence,
            generationId,
            expiresAtEpochMs
        }))
    };
}

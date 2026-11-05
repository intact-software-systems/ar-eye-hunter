import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    requireEpoch,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    rejectLeaveWith,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from './room-workflow-test-runtime.ts';

interface RequestCall {
    readonly url: string;
    readonly method: string;
    readonly body: object;
    readonly clientId: string | null;
}

const runtime = getRoomWorkflowMocks();
const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const requests: RequestCall[] = [];

installFakeBroadcastChannelPerTest();

describe('Quick Join through the browser facade and HTTP workflow', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
        requests.length = 0;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('selects once, connects presence, adopts the room, then leaves the previous room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const admitted = createRoomSnapshot('selected', []);
        let connected = createRoomSnapshot('selected', ['session-1']);
        seedRoomSnapshots([previous]);
        const facade = createRallarFacade();
        const currentWhenLeaving: (GroupSnapshot | undefined)[] = [];
        runtime.leaveStateGroup.mockImplementation(async () => {
            currentWhenLeaving.push(facade.rooms.current());
            return createRoomSnapshot('previous', []);
        });
        respond((call) => {
            if (isSelection(call)) {
                return createJsonResponse({ status: 'joined', snapshot: admitted });
            }
            connected = applyPresenceRequest(connected, call);
            return createJsonResponse(connected);
        });

        expect(await facade.rooms.quickJoin({ scope, kind: 'room', q: 'eye hunter', includeEmpty: true }))
            .toEqual({ status: 'joined', snapshot: connected });

        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({ method: 'POST', body: { kind: 'room', q: 'eye hunter', includeEmpty: true } });
        expect(requests[0].url).toMatch(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/quick-join\/requests\//);
        const publicationKey = toGroupPresencePublicationKey(runtime.publicationCrypto);
        expect(publicationKey).not.toBeNull();
        expect(requests[1]).toMatchObject({
            method: 'PUT',
            body: { principalId: 'principal-1', generationId: expect.any(String), publicationKey }
        });
        expect(requests[1].body).not.toMatchObject({ generationId: runtime.context.middleware.heartbeat.generationId });
        expect(requests[1].url).toMatch(/\/groups\/selected\/sessions\/session-1\/requests\//);
        expect(currentWhenLeaving).toEqual([connected]);
        expect(facade.rooms.current()).toEqual(connected);
    });

    it.each(['confirmed', 'failed'] as const)('keeps the source selected until delayed Quick Join arrival is %s', async (outcome) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const admitted = createRoomSnapshot('selected', []);
        const arrived = createRoomSnapshot('selected', ['session-1']);
        seedRoomSnapshots([previous]);
        const facade = createRallarFacade();
        const selectedRooms: (string | undefined)[] = [];
        const unsubscribe = facade.rooms.onChange((state) => {
            selectedRooms.push(state.currentRoomRef?.groupId);
        });
        let generationId = '';
        let arrivalRead = false;
        runtime.leaveStateGroup.mockImplementation(async () => {
            expect(arrivalRead).toBe(true);
            return createRoomSnapshot('previous', []);
        });
        respond((request) => {
            if (isSelection(request)) {
                return createJsonResponse({ status: 'joined', snapshot: admitted });
            }
            if (request.method === 'PUT') {
                const requested = requireRecord(request.body, 'Presence request').generationId;
                requireString(requested, 'generationId');
                generationId = requested;
                return createJsonResponse(admitted);
            }
            expect(facade.rooms.current()).toBe(previous);
            arrivalRead = true;
            const confirmed = {
                ...arrived,
                activeSessions: arrived.activeSessions.map((presence) => ({ ...presence, generationId, expiresAtEpochMs: Date.now() + 120_000 }))
            };
            return outcome === 'failed' ? new Response('Unavailable', { status: 503 }) : new Response(JSON.stringify(confirmed), {
                headers: {
                    'cache-control': 'no-store',
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': String(confirmed.causalRevision.groupRevision),
                    'rallar-presence-revision': String(confirmed.causalRevision.presenceRevision)
                }
            });
        });
        const joining = facade.rooms.quickJoin({ scope, maxAttempts: 1 });
        if (outcome === 'failed') {
            await expect(joining).rejects.toMatchObject({ name: 'RallarQuickJoinPartialFailureError', joinedRoom: admitted, cause: { status: 503 } });
            expect(facade.rooms.current()).toBe(previous);
        }
        else {
            await joining;
            expect(facade.rooms.current()?.activeSessions[0]).toMatchObject({ generationId, sessionId: 'session-1' });
        }
        expect(selectedRooms.filter((room, index) => index === 0 || room !== selectedRooms[index - 1]))
            .toEqual(outcome === 'failed' ? ['previous'] : ['previous', 'selected']);
        expect(arrivalRead).toBe(true);
        unsubscribe();
    });

    it('preserves the current room when unavailable and sends no presence or leave mutation', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous]);
        respond(() => createJsonResponse({ status: 'unavailable' }));
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin()).resolves.toEqual({ status: 'unavailable' });

        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({});
        expect(runtime.leaveStateGroup).not.toHaveBeenCalled();
        expect(facade.rooms.current()).toBe(previous);
    });

    it('retries each HTTP step with its original request identity', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const admitted = createRoomSnapshot('selected', []);
        let connected = createRoomSnapshot('selected', ['session-1']);
        let selectionAttempts = 0;
        let presenceAttempts = 0;
        respond((call) => {
            const attempt = isSelection(call) ? ++selectionAttempts : ++presenceAttempts;
            if (attempt === 1) {
                return new Response('transient', { status: 503 });
            }
            if (isSelection(call)) {
                return createJsonResponse({ status: 'joined', snapshot: admitted });
            }
            connected = applyPresenceRequest(connected, call);
            return createJsonResponse(connected);
        });

        expect(await createRallarFacade().rooms.quickJoin({ scope, maxAttempts: 2 }))
            .toEqual({ status: 'joined', snapshot: connected });

        expect(requests).toHaveLength(4);
        expect(requests[0].url).toBe(requests[1].url);
        expect(requests[2].url).toBe(requests[3].url);
        expect(requests[1].url).not.toBe(requests[2].url);
    });

    it('exposes admitted membership when presence fails without selecting another room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const admitted = createRoomSnapshot('selected', []);
        seedRoomSnapshots([previous]);
        respond((call) => isSelection(call) ? createJsonResponse({ status: 'joined', snapshot: admitted }) : new Response('failed', { status: 503 }));
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin({ scope })).rejects.toMatchObject({
            name: 'RallarQuickJoinPartialFailureError',
            joinedRoom: admitted,
            cause: { status: 503 }
        });

        expect(requests).toHaveLength(2);
        expect(runtime.leaveStateGroup).not.toHaveBeenCalled();
        expect(facade.rooms.current()).toBe(previous);
    });

    it.each(['selection', 'presence'] as const)('does not adopt a result after auth changes during %s', async (stage) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const admitted = createRoomSnapshot('selected', []);
        seedRoomSnapshots([previous]);
        respond((call) => {
            if (isSelection(call) === (stage === 'selection')) {
                runtime.readSession.mockReturnValue({ ...runtime.session, sessionId: 'replacement-session' });
            }
            return createJsonResponse(isSelection(call) ? { status: 'joined', snapshot: admitted } : createRoomSnapshot('selected', ['session-1']));
        });
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin({ scope })).rejects.toMatchObject({
            name: 'RallarQuickJoinPartialFailureError',
            joinedRoom: admitted
        });

        expect(requests).toHaveLength(stage === 'selection' ? 1 : 2);
        expect(runtime.leaveStateGroup).not.toHaveBeenCalled();
        expect(facade.rooms.current()).toBeUndefined();
    });

    it('reports leave failure with the successfully joined room still current', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        let connected = createRoomSnapshot('selected', ['session-1']);
        const leaveError = new Error('leave failed');
        seedRoomSnapshots([previous]);
        rejectLeaveWith(leaveError);
        respond((call) => {
            if (isSelection(call)) {
                return createJsonResponse({ status: 'joined', snapshot: connected });
            }
            connected = applyPresenceRequest(connected, call);
            return createJsonResponse(connected);
        });
        const facade = createRallarFacade();

        const rejected = facade.rooms.quickJoin({ scope });
        await expect(rejected).rejects.toBeInstanceOf(Error);
        await expect(rejected).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'quick-join',
            joinedRoom: connected,
            previousRoomRef: previous.group,
            leaveError
        });
        expect(facade.rooms.current()).toEqual(connected);
        expect(requests).toHaveLength(2);
    });

    it.each(['initial-connect', 'connect', 'disconnect', 'member'] as const)('fences auth replacement during %s', async (stage) => {
        const { quickJoinRoom } = await import('@shared-web/browser/rooms/join-room.ts');
        const { RoomStateStore } = await import('@shared-web/browser/rooms/room-state-store.ts');
        const { createRallarStateCacheReadPort } = await import('@shared-web/browser/state-cache/rallar-state-store.ts');
        const actual = await vi.importActual<typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts')>(
            '@shared-web/browser/rooms/room-group-state-workflows.ts'
        );
        runtime.leaveStateGroup.mockImplementation(actual.leaveStateGroup);
        const previous = createRoomSnapshot('previous', ['session-1']);
        let connected = createRoomSnapshot('selected', ['session-1']);
        let current: GroupSnapshot | undefined = previous;
        seedRoomSnapshots([previous]);
        const replaceSession = () =>
            runtime.readSession.mockReturnValue({
                ...runtime.session,
                clientId: 'replacement-principal',
                sessionId: 'replacement-session'
            });
        let connections = 0;
        const connect = async () => {
            ++connections;
            if (
                (stage === 'initial-connect' && connections === 1) ||
                (stage === 'connect' && connections === 2)
            ) {
                replaceSession();
            }
            return { ...runtime.context, session: requireSession() };
        };
        const adopted: string[] = [];
        respond((call) => {
            if (
                (stage === 'disconnect' && call.url.includes('/disconnect/')) ||
                (stage === 'member' && call.url.includes('/members/'))
            ) {
                replaceSession();
            }
            if (isSelection(call)) {
                return createJsonResponse({ status: 'joined', snapshot: connected });
            }
            connected = applyPresenceRequest(connected, call);
            return createJsonResponse(connected);
        });
        const stateStore = new RoomStateStore({
            runtime: {
                currentRoomRef: () => current?.group,
                setCurrentRoom: (snapshot) => {
                    current = snapshot;
                },
                clearCurrentRoomIfMatches: () => {
                    current = undefined;
                },
                readDefaultScope: () => scope,
                resolveOperationScope: (requested) => requested ?? scope
            },
            readSession: runtime.readSession,
            stateCache: createRallarStateCacheReadPort()
        });

        const rejected = quickJoinRoom({
            options: { scope },
            stateStore,
            connect,
            requireSession,
            readPublicationKey: async () => null,
            resolveOperationOptions: (options) => options,
            resolveOperationScope: (requested) => requested ?? scope,
            resolveDefaultRoomRef: () => current?.group,
            runAuthAwareOperation: async (operation) => await operation(),
            acceptSnapshots: async ({ groups }) => {
                adopted.push(...groups.map((snapshot) => snapshot.group.groupId));
                seedRoomSnapshots(groups);
            },
            enteredRooms: {
                rememberEnteredRoom: () => undefined,
                forgetEnteredRoom: () => undefined
            }
        });
        await expect(rejected).rejects.toBeInstanceOf(Error);
        await expect(rejected).rejects.toMatchObject(
            stage === 'initial-connect' ? { name: 'AbortError' } : {
                name: 'RallarRoomSwitchPartialFailureError',
                operation: 'quick-join',
                joinedRoom: connected
            }
        );

        expect(requests).toHaveLength(stage === 'initial-connect' ? 0 : stage === 'connect' ? 2 : stage === 'disconnect' ? 3 : 4);
        expect(requests.every((call) => call.clientId === runtime.session.clientId)).toBe(true);
        expect(adopted).toEqual(stage === 'initial-connect' ? [] : ['selected']);
    });

    it('respects leaveCurrent false', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        seedRoomSnapshots([createRoomSnapshot('previous', ['session-1'])]);
        let connected = createRoomSnapshot('selected', ['session-1']);
        respond((call) => {
            if (isSelection(call)) {
                return createJsonResponse({ status: 'joined', snapshot: connected });
            }
            connected = applyPresenceRequest(connected, call);
            return createJsonResponse(connected);
        });
        const facade = createRallarFacade();

        await facade.rooms.quickJoin({ scope, leaveCurrent: false });

        expect(runtime.leaveStateGroup).not.toHaveBeenCalled();
        expect(facade.rooms.current()).toEqual(connected);
    });

    it('normalizes an untyped leave rejection at the switch boundary', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        seedRoomSnapshots([createRoomSnapshot('previous', ['session-1'])]);
        let connected = createRoomSnapshot('selected', ['session-1']);
        runtime.leaveStateGroup.mockRejectedValueOnce('leave transport closed');
        respond((call) => {
            if (isSelection(call)) {
                return createJsonResponse({ status: 'joined', snapshot: connected });
            }
            connected = applyPresenceRequest(connected, call);
            return createJsonResponse(connected);
        });

        await expect(createRallarFacade().rooms.quickJoin({ scope })).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            leaveError: expect.any(Error)
        });
    });

    it('joins a Relic-shaped room without enlisting an expedition hunter', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const base = createRoomSnapshot('relic-expedition', ['session-1']);
        let connected: GroupSnapshot = {
            ...base,
            group: { ...base.group, displayName: 'Relic Hunters Expedition', metadata: { expeditionId: 'expedition-1', hunters: [] } }
        };
        respond((call) => {
            if (isSelection(call)) {
                return createJsonResponse({ status: 'joined', snapshot: connected });
            }
            connected = applyPresenceRequest(connected, call);
            return createJsonResponse(connected);
        });
        const facade = createRallarFacade();

        const result = await facade.rooms.quickJoin({ scope, kind: 'room', q: 'relic hunters' });

        expect(result).toEqual({ status: 'joined', snapshot: connected });
        expect(facade.rooms.current()?.group.metadata).toEqual({ expeditionId: 'expedition-1', hunters: [] });
        expect(requests).toHaveLength(2);
    });
});

function requireSession(): AuthSession {
    const session = runtime.readSession();
    if (!session) {
        throw new Error('This room workflow requires an authenticated session.');
    }
    return session;
}

function respond(handler: (call: RequestCall) => Response): void {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const call = {
            url: String(url),
            method: init?.method ?? 'GET',
            body: requireRecord(JSON.parse(String(init?.body ?? '{}')), 'Room request'),
            clientId: new Headers(init?.headers).get('x-client-id')
        };
        requests.push(call);
        return handler(call);
    });
}

function isSelection(call: RequestCall): boolean {
    return call.url.includes('/groups/quick-join/requests/');
}

function createJsonResponse(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** The fixture server publishes the generation and lease from a successful presence command. */
function applyPresenceRequest(snapshot: GroupSnapshot, request: RequestCall): GroupSnapshot {
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

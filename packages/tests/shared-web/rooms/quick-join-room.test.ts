import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    mockRoomLeaveSuccess,
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
        const connected = createRoomSnapshot('selected', ['session-1']);
        seedRoomSnapshots([previous]);
        mockRoomLeaveSuccess(createRoomSnapshot('previous', []));
        respond((call) => isSelection(call) ? json({ status: 'joined', snapshot: admitted }) : json(connected));
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin({ scope, kind: 'room', q: 'eye hunter', includeEmpty: true }))
            .resolves.toEqual({ status: 'joined', snapshot: connected });

        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({ method: 'POST', body: { kind: 'room', q: 'eye hunter', includeEmpty: true } });
        expect(requests[0].url).toMatch(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/quick-join\/requests\//);
        expect(requests[1]).toMatchObject({ method: 'PUT', body: { principalId: 'principal-1', generationId: 'generation-session-1' } });
        expect(requests[1].url).toMatch(/\/groups\/selected\/sessions\/session-1\/requests\//);
        expect(runtime.operationLog).toEqual(['hydrate:selected', 'leave:previous', 'hydrate:previous']);
        expect(facade.rooms.current()).toEqual(connected);
    });

    it('preserves the current room when unavailable and sends no presence or leave mutation', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous]);
        respond(() => json({ status: 'unavailable' }));
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin()).resolves.toEqual({ status: 'unavailable' });

        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({});
        expect(runtime.operationLog).toEqual([]);
        expect(facade.rooms.current()).toBe(previous);
    });

    it('retries each HTTP step with its original request identity', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const admitted = createRoomSnapshot('selected', []);
        const connected = createRoomSnapshot('selected', ['session-1']);
        let selectionAttempts = 0;
        let presenceAttempts = 0;
        respond((call) => {
            const attempt = isSelection(call) ? ++selectionAttempts : ++presenceAttempts;
            return attempt === 1
                ? new Response('transient', { status: 503 })
                : json(isSelection(call) ? { status: 'joined', snapshot: admitted } : connected);
        });

        await expect(createRallarFacade().rooms.quickJoin({ scope, maxAttempts: 2 }))
            .resolves.toEqual({ status: 'joined', snapshot: connected });

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
        respond((call) => isSelection(call) ? json({ status: 'joined', snapshot: admitted }) : new Response('failed', { status: 503 }));
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin({ scope })).rejects.toMatchObject({
            name: 'RallarQuickJoinPartialFailureError',
            joinedRoom: admitted,
            cause: { status: 503 }
        });

        expect(requests).toHaveLength(2);
        expect(runtime.operationLog).toEqual([]);
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
            return json(isSelection(call) ? { status: 'joined', snapshot: admitted } : createRoomSnapshot('selected', ['session-1']));
        });
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin({ scope })).rejects.toMatchObject({
            name: 'RallarQuickJoinPartialFailureError',
            joinedRoom: admitted
        });

        expect(requests).toHaveLength(stage === 'selection' ? 1 : 2);
        expect(runtime.operationLog).toEqual([]);
        expect(facade.rooms.current()).toBeUndefined();
    });

    it('reports leave failure with the successfully joined room still current', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        const connected = createRoomSnapshot('selected', ['session-1']);
        const leaveError = new Error('leave failed');
        seedRoomSnapshots([previous]);
        rejectLeaveWith(leaveError);
        respond((call) => json(isSelection(call) ? { status: 'joined', snapshot: connected } : connected));
        const facade = createRallarFacade();

        await expect(facade.rooms.quickJoin({ scope })).rejects.toMatchObject({
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
        const connected = createRoomSnapshot('selected', ['session-1']);
        let current: GroupSnapshot | undefined = previous;
        seedRoomSnapshots([previous]);
        const replaceSession = () =>
            runtime.readSession.mockReturnValue({
                ...runtime.session,
                clientId: 'replacement-principal',
                sessionId: 'replacement-session'
            });
        const connect = vi.fn(async () => {
            if (
                (stage === 'initial-connect' && connect.mock.calls.length === 1) ||
                (stage === 'connect' && connect.mock.calls.length === 2)
            ) {
                replaceSession();
            }
            return { ...runtime.context, session: runtime.readSession() };
        });
        const adopted: string[] = [];
        respond((call) => {
            if (
                (stage === 'disconnect' && call.url.includes('/disconnect/')) ||
                (stage === 'member' && call.url.includes('/members/'))
            ) {
                replaceSession();
            }
            return json(isSelection(call) ? { status: 'joined', snapshot: connected } : connected);
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

        await expect(quickJoinRoom({
            options: { scope },
            stateStore,
            connect,
            requireSession: runtime.readSession,
            resolveOperationOptions: (options) => options,
            resolveOperationScope: (requested) => requested ?? scope,
            resolveDefaultRoomRef: () => current?.group,
            runAuthAwareOperation: async (operation) => await operation(),
            acceptSnapshots: async ({ groups }) => {
                adopted.push(...groups.map((snapshot) => snapshot.group.groupId));
                seedRoomSnapshots(groups);
            }
        })).rejects.toMatchObject(
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
        const connected = createRoomSnapshot('selected', ['session-1']);
        respond((call) => json(isSelection(call) ? { status: 'joined', snapshot: connected } : connected));
        const facade = createRallarFacade();

        await facade.rooms.quickJoin({ scope, leaveCurrent: false });

        expect(runtime.leaveStateGroup).not.toHaveBeenCalled();
        expect(facade.rooms.current()).toEqual(connected);
    });

    it('normalizes an untyped leave rejection at the switch boundary', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        seedRoomSnapshots([createRoomSnapshot('previous', ['session-1'])]);
        const connected = createRoomSnapshot('selected', ['session-1']);
        runtime.leaveStateGroup.mockRejectedValueOnce('leave transport closed');
        respond((call) => json(isSelection(call) ? { status: 'joined', snapshot: connected } : connected));

        await expect(createRallarFacade().rooms.quickJoin({ scope })).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            leaveError: expect.any(Error)
        });
    });

    it('joins a Relic-shaped room without enlisting an expedition hunter', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const base = createRoomSnapshot('relic-expedition', ['session-1']);
        const connected: GroupSnapshot = {
            ...base,
            group: { ...base.group, displayName: 'Relic Hunters Expedition', metadata: { expeditionId: 'expedition-1', hunters: [] } }
        };
        respond((call) => json(isSelection(call) ? { status: 'joined', snapshot: connected } : connected));
        const facade = createRallarFacade();

        const result = await facade.rooms.quickJoin({ scope, kind: 'room', q: 'relic hunters' });

        expect(result).toEqual({ status: 'joined', snapshot: connected });
        expect(facade.rooms.current()?.group.metadata).toEqual({ expeditionId: 'expedition-1', hunters: [] });
        expect(requests).toHaveLength(2);
    });
});

function respond(handler: (call: RequestCall) => Response): void {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const call = {
            url: String(url),
            method: init?.method ?? 'GET',
            body: JSON.parse(String(init?.body ?? '{}')),
            clientId: new Headers(init?.headers).get('x-client-id')
        };
        requests.push(call);
        return handler(call);
    });
}

function isSelection(call: RequestCall): boolean {
    return call.url.includes('/groups/quick-join/requests/');
}

function json(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

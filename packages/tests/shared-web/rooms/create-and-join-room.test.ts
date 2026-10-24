import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, getRoomWorkflowMocks, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from './room-workflow-test-runtime.ts';

interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly body: object;
}

const runtime = getRoomWorkflowMocks();
const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const requests: HttpRequest[] = [];
installFakeBroadcastChannelPerTest();

describe('room creation through the browser facade and HTTP workflow', () => {
    beforeEach(async () => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
        requests.length = 0;
        const actual = await vi.importActual<typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts')>(
            '@shared-web/browser/rooms/room-group-state-workflows.ts'
        );
        runtime.createAndJoinStateGroup.mockImplementation(actual.createAndJoinStateGroup);
        runtime.leaveStateGroup.mockImplementation(actual.leaveStateGroup);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates the requested scoped room and adopts it after presence succeeds', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createRoomSnapshot('new-room', ['session-1']);
        respond(() => json(snapshot));
        const facade = createRallarFacade();

        await expect(facade.rooms.create({ groupId: 'new-room', displayName: 'Friends', description: 'Private arena', joinMode: 'code', maxMembers: 8, scope }))
            .resolves.toEqual(snapshot);

        expect(requests).toHaveLength(2);
        expect(requests[0].url).toMatch(/\/apps\/app-1\/workspaces\/workspace-1\/groups\/requests\//);
        expect(requests[0].body).toMatchObject({
            groupId: 'new-room',
            displayName: 'Friends',
            description: 'Private arena',
            joinMode: 'code',
            maxMembers: 8,
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1'
        });
        expect(facade.rooms.current()).toEqual(snapshot);
    });

    it('retains the generated room identity and request key across a transient creation retry', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        respond(() => requests.length === 1 ? new Response('unavailable', { status: 503 }) : json(createRoomSnapshot('new-room', ['session-1'])));

        await createRallarFacade().rooms.create({ displayName: 'Friends', scope, maxAttempts: 2 });

        expect(requests).toHaveLength(3);
        expect(requests[0]).toEqual(requests[1]);
    });

    it('sends temporary retention intent through creation retries without placing it in app metadata', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createRoomSnapshot('temporary-room', ['session-1']);
        respond(() => requests.length === 1 ? new Response('unavailable', { status: 503 }) : json(snapshot));

        await createRallarFacade().rooms.create({
            displayName: 'Temporary room',
            scope,
            maxAttempts: 2,
            retention: { mode: 'temporary', reconnectGraceMs: 60_000 },
            metadata: { theme: 'forest' }
        });

        expect(requests).toHaveLength(3);
        expect(requests[0]).toEqual(requests[1]);
        expect(requests[0].body).toMatchObject({
            retention: { mode: 'temporary', reconnectGraceMs: 60_000 },
            metadata: { theme: 'forest' }
        });
    });

    it('sends unlisted creation through the facade without replacing room metadata', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const base = createRoomSnapshot('hidden-room', ['session-1']);
        const snapshot = { ...base, group: { ...base.group, metadata: { rallarDirectoryListing: 'unlisted', theme: 'forest' } } };
        respond(() => json(snapshot));
        const facade = createRallarFacade();

        await facade.rooms.create({
            groupId: 'hidden-room',
            displayName: 'Hidden',
            joinMode: 'open',
            directoryListing: 'unlisted',
            metadata: { theme: 'forest' },
            scope
        });

        expect(requests[0].body).toMatchObject({ directoryListing: 'unlisted', metadata: { theme: 'forest' } });
        expect(facade.rooms.current()).toEqual(snapshot);
    });

    it('adopts the new room before leaving the previous one', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('old-room', ['session-1']);
        const created = createRoomSnapshot('new-room', ['session-1']);
        seedRoomSnapshots([previous]);
        const facade = createRallarFacade();
        respond((request) => {
            if (request.url.includes('/old-room/')) {
                expect(facade.rooms.current()).toEqual(created);
                return json(createRoomSnapshot('old-room', []));
            }
            return json(created);
        });

        await expect(facade.rooms.createAndSwitch({ groupId: 'new-room', displayName: 'Friends', scope })).resolves.toEqual(created);

        expect(requests.filter((request) => request.url.includes('/old-room/'))).toHaveLength(2);
        expect(facade.rooms.current()).toEqual(created);
    });

    it('reports committed creation when presence fails without selecting or leaving another room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('old-room', ['session-1']);
        const created = createRoomSnapshot('new-room', []);
        seedRoomSnapshots([previous]);
        respond((request) => isCreation(request) ? json(created) : new Response('unavailable', { status: 503 }));
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({ displayName: 'Friends', scope })).rejects.toMatchObject({
            name: 'RallarRoomJoinPartialFailureError',
            joinedRoom: created,
            cause: { status: 503 }
        });

        expect(requests).toHaveLength(2);
        expect(facade.rooms.current()).toEqual(previous);
    });

    it('retains the created room when previous-room cleanup fails', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('old-room', ['session-1']);
        const created = createRoomSnapshot('new-room', ['session-1']);
        seedRoomSnapshots([previous]);
        respond((request) => request.url.includes('/old-room/') ? new Response('unavailable', { status: 503 }) : json(created));
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({ displayName: 'Friends', scope })).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'create-and-switch',
            joinedRoom: created,
            previousRoomRef: previous.group
        });
        expect(facade.rooms.current()).toEqual(created);
    });

    it('does not leave or change current selection when creation is denied', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('old-room', ['session-1']);
        seedRoomSnapshots([previous]);
        respond(() => new Response('denied', { status: 403 }));
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({ displayName: 'Friends', scope })).rejects.toMatchObject({ status: 403 });
        expect(requests).toHaveLength(1);
        expect(facade.rooms.current()).toEqual(previous);
    });

    it.each([
        { stage: 'creation', action: 'replace-account' },
        { stage: 'presence', action: 'replace-account' },
        { stage: 'creation', action: 'cancel' },
        { stage: 'presence', action: 'cancel' }
    ])('does not adopt or leave after $action during $stage', async ({ stage, action }) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        seedRoomSnapshots([createRoomSnapshot('old-room', ['session-1'])]);
        const controller = new AbortController();
        respond((request) => {
            if (isCreation(request) === (stage === 'creation')) {
                if (action === 'cancel') {
                    controller.abort();
                }
                else {
                    runtime.readSession.mockReturnValue({ ...runtime.session, clientId: 'other-principal', sessionId: 'other-session' });
                }
            }
            return json(createRoomSnapshot('new-room', ['session-1']));
        });
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({ displayName: 'Friends', scope, signal: controller.signal })).rejects.toBeInstanceOf(Error);
        expect(requests).toHaveLength(stage === 'creation' ? 1 : 2);
        expect(facade.rooms.current()?.group.groupId).not.toBe('new-room');
    });
});

function respond(handler: (request: HttpRequest) => Response): void {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request: HttpRequest = { url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) };
        requests.push(request);
        return handler(request);
    });
}

function isCreation(request: HttpRequest): boolean {
    return request.url.includes('/groups/requests/');
}

function json(value: object): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

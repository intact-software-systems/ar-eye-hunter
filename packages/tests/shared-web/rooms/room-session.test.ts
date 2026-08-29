import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createRoomSnapshot, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from './room-workflow-test-runtime.ts';

beforeEach(resetRoomWorkflowTestRuntime);
afterEach(() => vi.unstubAllGlobals());

it('exposes the owning room session operation', async () => {
    const { createRoomSession } = await import('@shared-web/browser/rooms/room-session.ts');
    expect(typeof createRoomSession).toBe('function');
});

it('binds a session to the selected room snapshot', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('room-1', ['session-1']);
    seedRoomSnapshots([snapshot]);

    const session = createRallarFacade().rooms.session('room-1');

    expect(session.roomRef).toEqual(snapshot.group);
    expect(session.snapshot()).toBe(snapshot);
});

it('reports a structured validation issue when no room session can be resolved', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    let thrown: unknown;

    try {
        createRallarFacade().rooms.session();
    }
    catch (error) {
        thrown = error;
    }

    expect(isRallarValidationError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
        issues: [
            {
                path: '$.roomRef',
                code: 'missing-room-ref',
                message: 'Cannot create room session: no scoped room reference.'
            }
        ]
    });
});

it('refreshes a bound room and its current topology', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    const observed = createRoomSnapshot('room-1', ['session-1']);
    const current = {
        ...observed,
        group: {
            ...observed.group,
            snapshotVersion: observed.group.snapshotVersion + 1
        },
        causalRevision: {
            groupRevision: observed.causalRevision.groupRevision + 1,
            presenceRevision: observed.causalRevision.presenceRevision
        }
    };
    seedRoomSnapshots([observed]);
    const fetchMock = vi.fn(async (
        input: RequestInfo | URL,
        _init?: RequestInit
    ) => {
        if (String(input).endsWith('/topology')) {
            return new Response(JSON.stringify({
                groupRef: current.group,
                overlayId: '["app-1","workspace-1","room-1"]',
                snapshot: null,
                config: null,
                pending: null
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
        return new Response(JSON.stringify(current), {
            status: 200,
            headers: {
                'cache-control': 'no-store',
                'content-type': 'application/json',
                'rallar-state-source': 'durable',
                'rallar-group-revision': String(current.causalRevision.groupRevision),
                'rallar-presence-revision': String(current.causalRevision.presenceRevision)
            }
        });
    });
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await createRallarFacade().rooms.session(observed.group).refresh();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
        'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology'
    );
    const request = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-1');
    expect(headers.get('x-client-id')).toBe('principal-1');
    expect(refreshed.snapshot()).toEqual(current);
});

it('conditionally cleans a targeted 404 and rethrows the original HTTP error', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    const observed = createRoomSnapshot('room-1', ['session-1']);
    seedRoomSnapshots([observed]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));

    const session = createRallarFacade().rooms.session(observed.group);
    let thrown: unknown;
    try {
        await session.refresh();
    }
    catch (error) {
        thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiHttpError);
    expect((thrown as ApiHttpError).status).toBe(404);
    expect(session.snapshot()).toBeUndefined();
});

it('preserves a newer publication that races targeted 404 cleanup', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    const observed = createRoomSnapshot('room-1', ['session-1']);
    const newer = {
        ...observed,
        causalRevision: {
            groupRevision: observed.causalRevision.groupRevision + 1,
            presenceRevision: observed.causalRevision.presenceRevision
        }
    };
    seedRoomSnapshots([observed]);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            seedRoomSnapshots([newer]);
            return new Response('missing', { status: 404 });
        })
    );

    const session = createRallarFacade().rooms.session(observed.group);
    await expect(session.refresh()).rejects.toBeInstanceOf(ApiHttpError);

    expect(session.snapshot()).toBe(newer);
});

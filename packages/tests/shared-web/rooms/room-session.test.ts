import {
    afterEach,
    beforeEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import {
    findGroupStateSnapshotByRef,
    onGroupStateSnapshotChange,
    waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';
import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    createRoomSnapshot,
    readRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from './room-workflow-test-runtime.ts';

beforeEach(() => {
    resetRoomWorkflowTestRuntime();
    configureOverlayRepositories({
        plannedOverlays: { ttlMs: 60_000 },
        acceptedOverlays: { ttlMs: 60_000 }
    });
});
afterEach(() => vi.unstubAllGlobals());

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
    let thrown: Error | undefined;

    try {
        createRallarFacade().rooms.session();
    }
    catch (error) {
        thrown = toError(error);
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
    const topology = createEmptyTopology(current.group);
    seedRoomSnapshots([observed]);
    let groupReadObserved = false;
    let topologyReadObserved = false;
    const fetchMock = vi.fn(async (
        input: RequestInfo | URL,
        _init?: RequestInit
    ) => {
        if (String(input).endsWith('/topology')) {
            if (!groupReadObserved) {
                throw new Error('Topology was read before the current group snapshot.');
            }
            topologyReadObserved = true;
            return new Response(JSON.stringify(topology), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
        groupReadObserved = true;
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

    expect(groupReadObserved).toBe(true);
    expect(topologyReadObserved).toBe(true);
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
    let thrown: Error | undefined;
    try {
        await session.refresh();
    }
    catch (error) {
        thrown = toError(error);
    }

    expect(thrown).toBeInstanceOf(ApiHttpError);
    expect(thrown).toMatchObject({ status: 404 });
    expect(session.snapshot()).toBeUndefined();
});

it('preserves a newer publication that races targeted 404 cleanup', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    const observed = createRoomSnapshot('room-1', ['session-1']);
    const newer = {
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

it.each(['equal', 'aborted', 'stale-session', 'wrong-scope', 'failed'] as const)(
    'renews a bound room only after a current exact authoritative acquisition: %s',
    async (outcome) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const original = createRoomSnapshot('fresh-room', ['session-1']);
        const snapshot = {
            ...original,
            activeSessions: original.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: 300_000 }))
        };
        seedRoomSnapshots([snapshot]);
        await waitForGroupStateSnapshotChangesIdle();
        const events: ObservableValueEventType[] = [];
        onTestFinished(onGroupStateSnapshotChange((change) => {
            events.push(change.kind);
        }));
        const requested = Promise.withResolvers<void>();
        const response = Promise.withResolvers<Response>();
        vi.stubGlobal('fetch', (url: RequestInfo | URL) => {
            if (String(url).endsWith('/topology')) {
                return Promise.resolve(
                    new Response(JSON.stringify(createEmptyTopology(snapshot.group)), {
                        headers: { 'content-type': 'application/json' }
                    })
                );
            }
            requested.resolve();
            return response.promise;
        });
        const roomSession = createRallarFacade().rooms.session(snapshot.group);
        const controller = new AbortController();
        vi.setSystemTime(51_000);
        const refreshing = roomSession.refresh({ signal: controller.signal });
        const completion = refreshing.then(() => 'completed', (error: Error) => error);
        await requested.promise;
        if (outcome === 'aborted') {
            controller.abort();
        }
        if (outcome === 'stale-session') {
            const runtime = readRoomWorkflowMocks();
            runtime.readSession.mockReturnValue({ ...runtime.session, sessionId: 'replacement-session' });
        }
        const acquired = outcome === 'wrong-scope'
            ? { ...snapshot, group: { ...snapshot.group, workspaceId: 'wrong' } }
            : snapshot;
        response.resolve(
            outcome === 'failed' ? new Response('', { status: 503 }) : new Response(JSON.stringify(acquired), {
                headers: {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': '1',
                    'rallar-presence-revision': '1'
                }
            })
        );
        const result = await completion;
        await waitForGroupStateSnapshotChangesIdle();
        vi.setSystemTime(62_000);
        if (outcome === 'equal') {
            expect(result).toBe('completed');
            expect(events).toEqual([ObservableValueEventType.Refreshed]);
            expect(findGroupStateSnapshotByRef(snapshot.group)).toBe(snapshot);
        }
        else {
            expect(result).toBeInstanceOf(Error);
            expect(events).toEqual([]);
            expect(findGroupStateSnapshotByRef(snapshot.group)).toBeUndefined();
        }
    }
);

function createEmptyTopology(groupRef: GroupRef): GroupTopologyManagementView {
    return {
        groupRef,
        overlayId: toScopedOverlayId(groupRef),
        snapshot: null,
        acceptedSnapshot: null,
        config: {
            serverDefaults: { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 3, meshMinSize: 8, meshParamK: 2 },
            durable: null,
            temporary: null,
            requestOptions: null,
            effective: { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 3, meshMinSize: 8, meshParamK: 2 }
        },
        pending: null
    };
}

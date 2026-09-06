import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { RallarRoomFormation } from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import {
    GROUP_LIFECYCLE_COMMANDS,
    type GroupLifecycleCommand
} from '@shared/api/group-lifecycle/group-lifecycle-commands.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
import { CommandCancelledError } from '@shared/cache/Command.ts';
import {
    configureOverlayRepositories,
    removeAcceptedOverlayByGroupRef,
    removePlannedOverlayByGroupRef,
    setPlannedOverlayById
} from '@shared/repository/overlays-repository.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { readRoomWorkflowMocks, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot, createLayoutOverlay } from './room-formation-test-fixtures.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();
const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const topologyConfig = { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 3, meshMinSize: 8, meshParamK: 2 } as const;

function topologyView(groupRef: GroupRef): GroupTopologyManagementView {
    return {
        groupRef,
        overlayId: toScopedOverlayId(groupRef),
        snapshot: null,
        acceptedSnapshot: null,
        config: { serverDefaults: topologyConfig, durable: null, temporary: null, requestOptions: null, effective: topologyConfig },
        pending: null
    };
}

function stubReceipt(receipt: GroupSnapshot) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function pointReadResponse(snapshot: GroupSnapshot): Response {
    return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(snapshot.causalRevision.groupRevision),
            'rallar-presence-revision': String(snapshot.causalRevision.presenceRevision)
        }
    });
}

const explicitLayout = { groupRevision: 6, presenceRevision: 2, version: 8, state: 'active' } as const;
const commandInvocations = {
    plan: (formation) => formation.plan(),
    connect: (formation) => formation.connect({ layout: explicitLayout }),
    activate: (formation) => formation.activate(),
    reconfigure: (formation) => formation.reconfigure({ landing: 'hold' }),
    pause: (formation) => formation.pause(),
    resume: (formation) => formation.resume(),
    reset: (formation) => formation.reset(),
    start: (formation) => formation.start()
} satisfies Record<GroupLifecycleCommand, (formation: RallarRoomFormation) => Promise<GroupSnapshot>>;
const commandBodies = {
    plan: {},
    connect: { expectedFormationEpoch: 3, expectedLayout: explicitLayout },
    activate: {},
    reconfigure: { landing: 'hold' },
    pause: {},
    resume: {},
    reset: {},
    start: {}
} satisfies Record<GroupLifecycleCommand, object>;

describe('room formation commands', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        configureOverlayRepositories({ plannedOverlays: { ttlMs: 60_000 }, acceptedOverlays: { ttlMs: 60_000 } });
        removePlannedOverlayByGroupRef(roomRef);
        removeAcceptedOverlayByGroupRef(roomRef);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('plans through the bound room and accepts the receipt into the cache', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const forming = createFormationSnapshot({
            stage: 'forming',
            formationEpoch: 0,
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([forming]);
        const fetchMock = stubReceipt(planned);
        const facade = createRallarFacade();

        const receipt = await facade.rooms.formation('room-1').plan({ reason: 'lobby ready' });

        expect(receipt).toEqual(planned);
        expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
            /^https:\/\/api\.example\.test\/api\/state\/apps\/app-1\/workspaces\/workspace-1\/groups\/room-1\/lifecycle\/plan\/requests\/[0-9a-f-]{36}$/
        );
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ reason: 'lobby ready' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(roomWorkflowMocks.operationLog).toContain('hydrate:room-1');
        expect(facade.rooms.formation('room-1').status()?.stage).toBe('planned');
    });

    it('connects the current planned layout with the cached epoch', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        setPlannedOverlayById(
            toScopedOverlayId(planned.group),
            createLayoutOverlay({ roomRef: planned.group, causalRevision: { groupRevision: 2, presenceRevision: 1 }, version: 3 })
        );
        const fetchMock = stubReceipt(
            createFormationSnapshot({
                stage: 'connecting',
                formationEpoch: 2,
                causalRevision: { groupRevision: 3, presenceRevision: 1 }
            })
        );

        await createRallarFacade().rooms.formation(planned.group).connect();

        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            expectedFormationEpoch: 1,
            expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses to connect locally when no planned layout exists after a read-through', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/topology')) {
                return new Response(
                    JSON.stringify({
                        groupRef: planned.group,
                        overlayId: toScopedOverlayId(planned.group),
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
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            return new Response(JSON.stringify(planned), {
                status: 200,
                headers: {
                    'cache-control': 'no-store',
                    'content-type': 'application/json',
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': '2',
                    'rallar-presence-revision': '1'
                }
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        let thrown: Error | undefined;

        try {
            await createRallarFacade().rooms.formation(planned.group).connect();
        }
        catch (error) {
            thrown = toError(error);
        }

        expect(isRallarValidationError(thrown)).toBe(true);
        expect(thrown).toMatchObject({ issues: [{ path: '$.layout', code: 'no-planned-layout' }] });
        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology'
        ]);
    });

    it('runs the connect read-through under the caller\'s operation options', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        stubReceipt(planned);
        const controller = new AbortController();
        controller.abort();

        // A read-through that ignored the signal would end in the no-planned-layout
        // refusal instead; the cancellation proves it never reached the transport.
        await expect(createRallarFacade().rooms.formation(planned.group).connect({ signal: controller.signal }))
            .rejects.toBeInstanceOf(CommandCancelledError);
    });

    it('reads the room through before connecting when the cached snapshot lags the planned layout', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const stale = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        const fresh = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 2,
            causalRevision: { groupRevision: 4, presenceRevision: 1 }
        });
        seedRoomSnapshots([stale]);
        setPlannedOverlayById(
            toScopedOverlayId(stale.group),
            createLayoutOverlay({
                roomRef: stale.group,
                causalRevision: { groupRevision: 4, presenceRevision: 1 },
                version: 3
            })
        );
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return new Response(JSON.stringify(fresh), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (String(input).endsWith('/topology')) {
                return new Response(JSON.stringify(topologyView(fresh.group)), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }
            return new Response(JSON.stringify(fresh), {
                status: 200,
                headers: {
                    'cache-control': 'no-store',
                    'content-type': 'application/json',
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': '4',
                    'rallar-presence-revision': '1'
                }
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        await createRallarFacade().rooms.formation(stale.group).connect();

        expect(fetchMock.mock.calls.map((call) => `${call[1]?.method ?? 'GET'} ${String(call[0]).split('/groups/room-1')[1] ?? ''}`))
            .toEqual(['GET ', 'GET /topology', expect.stringMatching(/^POST \/lifecycle\/connect\/requests\//)]);
        expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
            expectedFormationEpoch: 2,
            expectedLayout: { groupRevision: 4, presenceRevision: 1, version: 3, state: 'active' }
        });
    });

    it('forgets the planned layout the server refused so the next connect reads through', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        setPlannedOverlayById(
            toScopedOverlayId(planned.group),
            createLayoutOverlay({
                roomRef: planned.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 2
            })
        );
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    type: 'api-mutation-failure',
                    version: 'canonical.v2',
                    code: 'group-connect-planned-layout-superseded',
                    status: 409,
                    message: 'Rejected',
                    issues: null,
                    denial: null,
                    retry: null
                }),
                { status: 409, headers: { 'content-type': 'application/json' } }
            )
        );
        vi.stubGlobal('fetch', fetchMock);
        const formation = createRallarFacade().rooms.formation(planned.group);

        await expect(formation.connect()).rejects.toMatchObject({ status: 409 });

        expect(formation.status()?.planned).toBeUndefined();
    });

    it.each(GROUP_LIFECYCLE_COMMANDS)('posts %s under its own lifecycle route with the body its schema declares', async (command) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const active = createFormationSnapshot({
            stage: 'active',
            formationEpoch: 3,
            causalRevision: { groupRevision: 5, presenceRevision: 2 }
        });
        seedRoomSnapshots([active]);
        const fetchMock = stubReceipt(active);

        await commandInvocations[command](createRallarFacade().rooms.formation(active.group));

        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(String(url)).toMatch(
            new RegExp(
                '^https://api\\.example\\.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1' +
                    `/lifecycle/${command}/requests/[0-9a-f-]{36}$`
            )
        );
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual(commandBodies[command]);
    });

    it('refuses to connect for a session the room does not count as present', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 },
            sessionIds: ['other-session']
        });
        seedRoomSnapshots([planned]);
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => pointReadResponse(planned)));

        await expect(createRallarFacade().rooms.formation(planned.group).connect()).rejects.toMatchObject({
            issues: [{ path: '$.layout', code: 'session-not-present' }]
        });
    });

    it('refuses to connect when the planned layout could not be read through', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
                String(input).endsWith('/topology')
                    ? new Response('unavailable', { status: 503 })
                    : pointReadResponse(planned)
            )
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await expect(createRallarFacade().rooms.formation(planned.group).connect()).rejects.toMatchObject({
                issues: [{ path: '$.layout', code: 'planned-layout-read-failed' }]
            });
        }
        finally {
            warn.mockRestore();
        }
    });
});

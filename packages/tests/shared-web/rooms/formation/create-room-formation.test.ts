import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
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

function stubReceipt(receipt: GroupSnapshot) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

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
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            actorPrincipalId: roomWorkflowMocks.session.clientId,
            actorSessionId: roomWorkflowMocks.session.sessionId,
            reason: 'lobby ready'
        });
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
            actorPrincipalId: roomWorkflowMocks.session.clientId,
            actorSessionId: roomWorkflowMocks.session.sessionId,
            expectedFormationEpoch: 1,
            expectedLayout: { groupRevision: 2, presenceRevision: 1, version: 3, state: 'active' }
        });
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
        const fetchMock = stubReceipt(planned);
        const controller = new AbortController();
        controller.abort();

        await expect(createRallarFacade().rooms.formation(planned.group).connect({ signal: controller.signal }))
            .rejects.toThrow();

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends an explicit layout and a reconfigure landing verbatim', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const active = createFormationSnapshot({
            stage: 'active',
            formationEpoch: 3,
            causalRevision: { groupRevision: 5, presenceRevision: 2 }
        });
        seedRoomSnapshots([active]);
        const fetchMock = stubReceipt(active);
        const formation = createRallarFacade().rooms.formation(active.group);

        await formation.reconfigure({ landing: 'hold' });
        await formation.connect({ layout: { groupRevision: 6, presenceRevision: 2, version: 8, state: 'active' } });

        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ landing: 'hold' });
        expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
            expectedFormationEpoch: 3,
            expectedLayout: { groupRevision: 6, presenceRevision: 2, version: 8, state: 'active' }
        });
    });
});

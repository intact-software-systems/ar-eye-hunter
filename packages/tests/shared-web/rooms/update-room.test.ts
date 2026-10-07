import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import type * as RoomGroupStateMutationWorkflows from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = getRoomWorkflowMocks();

installFakeBroadcastChannelPerTest();

beforeEach(resetRoomWorkflowTestRuntime);

afterEach(() => {
    vi.unstubAllGlobals();
});

it('routes a detail update through the room update owner', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('room-1', ['session-1']);
    roomWorkflowMocks.updateStateGroupDetails.mockResolvedValue(snapshot);

    await expect(
        createRallarFacade().rooms.update({ roomId: 'room-1', displayName: 'Room 1' })
    ).resolves.toBe(snapshot);

    expect(roomWorkflowMocks.updateStateGroupDetails).toHaveBeenCalledWith(
        {
            groupId: 'room-1',
            request: { displayName: 'Room 1' },
            principalId: 'principal-1',
            sessionId: 'session-1',
            scope: { applicationId: 'rallar-server', workspaceId: 'default' },
            policies: {}
        }
    );
});

it('removes a key the facade patches to null from the metadata the room update sends, keeping every other key', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const workflows = await vi.importActual<typeof RoomGroupStateMutationWorkflows>(
        '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'
    );
    roomWorkflowMocks.updateStateGroupMetadata.mockImplementation(workflows.updateStateGroupMetadata);
    const base = createRoomSnapshot('room-1', ['session-1'], { applicationId: 'rallar-server', workspaceId: 'default' });
    const stored = { ...base, group: { ...base.group, metadata: { k: 1, keep: true } } };
    const sentBodies: unknown[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if ((init?.method ?? 'GET') === 'GET') {
                return toGroupPointResponse(stored);
            }
            const body: unknown = JSON.parse(String(init?.body));
            sentBodies.push(body);
            return toJsonResponse({ ...stored, group: { ...stored.group, metadata: { keep: true } } });
        })
    );

    await createRallarFacade().rooms.updateMetadata('room-1', { k: null });

    expect(sentBodies).toEqual([expect.objectContaining({ metadata: { keep: true } })]);
});

function toJsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function toGroupPointResponse(body: GroupSnapshot): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(body.causalRevision.groupRevision),
            'rallar-presence-revision': String(body.causalRevision.presenceRevision)
        }
    });
}

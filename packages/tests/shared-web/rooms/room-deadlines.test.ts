import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, getRoomWorkflowMocks, resetRoomWorkflowTestRuntime } from './room-workflow-test-runtime.ts';

const room = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const groupPath = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
const change = { name: 'poll.close', expectedRevision: 0, atEpochMs: 9000 };
const deadline = { name: change.name, revision: 1, atEpochMs: change.atEpochMs };

installFakeBroadcastChannelPerTest();

beforeEach(() => {
    resetRoomWorkflowTestRuntime();
    configureApiClient({ apiBaseUrl: '' });
});
afterEach(() => vi.unstubAllGlobals());

function groupResponse(deadlines: readonly (typeof deadline)[], groupId = room.groupId, source = 'durable'): Response {
    const snapshot = createRoomSnapshot(groupId, ['session-1']);
    return Response.json({
        ...snapshot,
        group: { ...snapshot.group, metadata: { rallarRoomDeadlines: deadlines } }
    }, {
        headers: {
            'cache-control': 'no-store',
            'rallar-state-source': source,
            'rallar-group-revision': '1',
            'rallar-presence-revision': '1'
        }
    });
}

it('reads the requested room afresh with the captured credential and distinguishes an absent deadline', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    let deadlines: (typeof deadline)[] = [];
    vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
        expect(path).toBe(groupPath);
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + getRoomWorkflowMocks().session.accessToken);
        return Promise.resolve(groupResponse(deadlines));
    });
    const { rooms } = createRallarFacade();
    await expect(rooms.readDeadline(room, change.name)).resolves.toBeNull();
    deadlines = [deadline];
    await expect(rooms.readDeadline(room, change.name)).resolves.toEqual(deadline);
});

it('addresses the same receipt on replay and returns the acknowledged revision', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
        expect(path).toBe(groupPath + '/requests/poll-create-request-0001');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(String(init.body))).toEqual({
            roomDeadline: change,
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1'
        });
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + getRoomWorkflowMocks().session.accessToken);
        return Promise.resolve(groupResponse([deadline]));
    });
    const { rooms } = createRallarFacade();
    await expect(rooms.setDeadline(room, change, 'poll-create-request-0001')).resolves.toEqual(deadline);
    await expect(rooms.setDeadline(room, change, 'poll-create-request-0001')).resolves.toEqual(deadline);
});

it.each(['read', 'set'] as const)('rejects an obsolete session and a wrong-room %s response', async (method) => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const { rooms } = createRallarFacade();
    const run = () => method === 'read' ? rooms.readDeadline(room, change.name) : rooms.setDeadline(room, change, 'poll-create-request-0001');
    vi.stubGlobal('fetch', () => Promise.resolve(groupResponse([deadline], 'other')));
    await expect(run()).rejects.toThrow(/group|room/i);

    const { session, readSession } = getRoomWorkflowMocks();
    readSession.mockReturnValue({ ...session, clientId: 'one:two', sessionId: 'three' });
    vi.stubGlobal('fetch', () => {
        readSession.mockReturnValue({ ...session, clientId: 'one', sessionId: 'two:three' });
        return Promise.resolve(groupResponse([deadline]));
    });
    await expect(run()).rejects.toThrow(/obsolete session/i);
});

it('rejects cached authority and a mismatched write acknowledgement', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const { rooms } = createRallarFacade();
    vi.stubGlobal('fetch', () => Promise.resolve(groupResponse([deadline], room.groupId, 'cache')));
    await expect(rooms.readDeadline(room, change.name)).rejects.toThrow(/durable/i);
    vi.stubGlobal('fetch', () => Promise.resolve(groupResponse([{ ...deadline, revision: 2 }])));
    await expect(rooms.setDeadline(room, change, 'poll-create-request-0001')).rejects.toThrow(/acknowledge/i);
});

it('requires authentication and an explicit workspace before issuing requests', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const { rooms } = createRallarFacade();
    await expect(rooms.readDeadline({ ...room, workspaceId: '' }, change.name)).rejects.toThrow(/workspace/i);
    getRoomWorkflowMocks().readSession.mockReturnValue(undefined);
    await expect(rooms.readDeadline(room, change.name)).rejects.toThrow(/auth session/i);
    await expect(rooms.setDeadline(room, change, 'poll-create-request-0001')).rejects.toThrow(/auth session/i);
});

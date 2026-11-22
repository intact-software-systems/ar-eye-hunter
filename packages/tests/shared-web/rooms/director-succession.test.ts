import type { RoomDirectorOperations } from '@shared-web/browser/director/room-director-operations.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { RoomDirectorSuccession } from '@shared/api/room-directors/room-director-succession-record.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, resetRoomWorkflowTestRuntime } from './room-workflow-test-runtime.ts';

const room = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const state: RoomDirectorSuccession = {
    revision: 1, reconnectWindowMs: 30000, deputyWindowMs: 30000, deputyPrincipalId: 'player',
    directorLeaseExpiresAtEpochMs: null, spectatorDirectorEpoch: null, loss: null
};
const policy = { operation: 'configure', expectedDirectorEpoch: 0, expectedRevision: 0, deputyPrincipalId: 'player' } as const;
installFakeBroadcastChannelPerTest();
beforeEach(() => { resetRoomWorkflowTestRuntime(); configureApiClient({ apiBaseUrl: '' }); });
afterEach(() => vi.unstubAllGlobals());

function response(metadata: object, revision = 1) {
    const snapshot = createRoomSnapshot(room.groupId, ['session-1']);
    return Response.json({ ...snapshot, causalRevision: { ...snapshot.causalRevision, groupRevision: revision }, group: { ...snapshot.group, snapshotVersion: revision, metadata } }, { headers: {
        'cache-control': 'no-store', 'rallar-state-source': 'durable', 'rallar-group-revision': String(revision), 'rallar-presence-revision': '1'
    } });
}

it('writes the captured policy revision to the appointment route and verifies an acknowledgement', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const api = createRallarFacade().rooms;
    const requestId = 'director-policy-00000001';
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/director/appoint/requests/' + requestId);
        expect(JSON.parse(String(init.body))).toEqual({ actorPrincipalId: 'principal-1', actorSessionId: 'session-1', succession: policy });
        return response({ rallarDirectorSuccession: state });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(api.changeDirector(room, policy, requestId)).resolves.toMatchObject({ appointment: null, succession: state });
    fetch.mockImplementationOnce(async () => response({}));
    await expect(api.changeDirector(room, policy, requestId)).rejects.toThrow(/acknowledge/i);
});

it('recovers durable director policy on foreground without issuing idle reads or claiming automatically', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const { rooms, ws } = createRallarFacade();
    vi.spyOn(ws, 'status').mockReturnValue({ ...ws.status(), isOpen: true });
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let stored = state;
    const fetch = vi.fn(async () => response({ rallarDirectorSuccession: stored }, stored.revision));
    vi.stubGlobal('fetch', fetch);
    const observed: RoomDirectorOperations.Observation[] = [];
    const stop = rooms.watchDirector(room, observation => observed.push(observation));
    try {
        await vi.waitFor(() => expect(observed.at(-1)).toMatchObject({ status: 'current', value: { succession: state } }));
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(300000);
        expect(fetch).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
        page.dispatchEvent(new Event('pagehide'));
        stored = { ...state, revision: 2, deputyPrincipalId: 'replacement' };
        page.dispatchEvent(new Event('pageshow'));
        await vi.waitFor(() => expect(observed.at(-1)).toMatchObject({ status: 'current', value: { succession: stored } }));
        expect(fetch).toHaveBeenCalledTimes(2);
    }
    finally { vi.useRealTimers(); stop(); }
});

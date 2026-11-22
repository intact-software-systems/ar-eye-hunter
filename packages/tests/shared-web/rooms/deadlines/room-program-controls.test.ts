import { AppTopics } from '@shared/api/api-config.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFakeBroadcastChannelPerTest } from '../../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, getRoomWorkflowMocks, resetRoomWorkflowTestRuntime } from '../room-workflow-test-runtime.ts';

const room = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const program = { name: 'court', elapsedThroughEpochMs: 1500, phases: [{ phase: 'first', startsAtEpochMs: 1000 }, { phase: 'second', startsAtEpochMs: 4000 }] };
const paused = { ...program, revision: 2, status: 'program-paused' as const };
const resumed = {
    ...program,
    revision: 3,
    status: 'scheduled' as const,
    elapsedThroughEpochMs: 2150,
    phases: [program.phases[0], { phase: 'second', startsAtEpochMs: 4650 }]
};
const path = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
installFakeBroadcastChannelPerTest();
beforeEach(() => {
    resetRoomWorkflowTestRuntime();
    configureApiClient({ apiBaseUrl: '' });
});
afterEach(() => vi.unstubAllGlobals());

function response(schedule: RoomSchedule): Response {
    const snapshot = createRoomSnapshot(room.groupId, ['session-1']);
    return Response.json({ ...snapshot, group: { ...snapshot.group, metadata: { rallarRoomClocks: [schedule] } } }, {
        headers: {
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': '1',
            'rallar-presence-revision': '1'
        }
    });
}

it('uses the captured director and program revision for both transitions and their retries', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const api = createRallarFacade().rooms;
    for (const [operation, schedule] of [['pause-program', paused], ['resume-program', resumed]] as const) {
        const control = { name: 'court', expectedRevision: schedule.revision - 1, expectedDirectorEpoch: 7 };
        const requestId = 'court-program-request-' + schedule.revision;
        const requests: { url: string; body: string; }[] = [];
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            requests.push({ url, body: String(init.body) });
            return response(schedule);
        });
        const act = operation === 'pause-program' ? api.pauseProgram : api.resumeProgram;
        await expect(act(room, control, requestId)).resolves.toEqual(schedule);
        await expect(act(room, control, requestId)).resolves.toEqual(schedule);
        const expectedRequest = {
            url: path + '/requests/' + requestId,
            body: {
                actorPrincipalId: 'principal-1',
                actorSessionId: 'session-1',
                roomClock: { ...control, operation }
            }
        };
        expect(requests.map(({ url, body }) => ({ url, body: JSON.parse(body) }))).toEqual([expectedRequest, expectedRequest]);
    }
});

it('requires the requested transition state as well as the acknowledged revision', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    vi.stubGlobal('fetch', async () => response({ ...paused, status: 'scheduled' }));
    await expect(createRallarFacade().rooms.pauseProgram(room, { name: 'court', expectedRevision: 1, expectedDirectorEpoch: 7 }, 'court-program-request-pause'))
        .rejects.toThrow(/acknowledgement/);
});

it('recovers a missed resume on foreground without accepting a different state at the same revision', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const { rooms, ws } = createRallarFacade();
    vi.spyOn(ws, 'status').mockReturnValue({ ...ws.status(), isOpen: true });
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let stored: RoomSchedule = paused;
    vi.stubGlobal('fetch', async () => {
        const snapshot = response(stored);
        stored = resumed;
        return snapshot;
    });
    const observed: RoomSchedule.Observation[] = [];
    const stop = rooms.watchSchedule(room, 'court', (observation) => observed.push(observation));
    try {
        await vi.waitFor(() => expect(observed.at(-1)).toEqual({ status: 'current', schedule: paused }));
        page.dispatchEvent(new Event('pagehide'));
        stored = { ...paused, status: 'scheduled' };
        page.dispatchEvent(new Event('pageshow'));
        await expect.poll(() => observed.at(-1), { timeout: 5000 }).toEqual({ status: 'current', schedule: resumed });
        expect(observed).toContainEqual({ status: 'stale', schedule: paused });
        expect(observed.some(({ status, schedule }) => status === 'current' && schedule?.revision === 2 && schedule.status === 'scheduled')).toBe(false);
    }
    finally {
        stop();
    }
});

it('repairs a missed resume and ban on server resync while the browser socket stays open', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    await facade.connect();
    const { rooms, ws } = facade;
    vi.spyOn(ws, 'status').mockReturnValue({ ...ws.status(), isOpen: true });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { onLine: true });
    let stored: RoomSchedule | null = paused;
    vi.stubGlobal('fetch', async () => stored ? response(stored) : Response.json({ error: 'Forbidden' }, { status: 403 }));
    const observed: RoomSchedule.Observation[] = [];
    const stop = rooms.watchSchedule(room, 'court', value => observed.push(value));
    async function resync() {
        const topic = AppTopics.viewResync;
        const message = newALBroadcastMessage({
            createdAtEpochMs: Date.now(), senderId: 'server', route: newALRoute(topic, crypto.randomUUID(), 'all'),
            scope: 'all', typeId: topic, resource: { version: 1 }
        });
        const { webSocketQueueBox } = getRoomWorkflowMocks().context.middleware;
        const inbox = vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mock.calls.at(-1)![1];
        await inbox.onMessage(message, toResourceEntry(topic, message));
    }
    try {
        await vi.waitFor(() => expect(observed.at(-1)).toEqual({ status: 'current', schedule: paused }));
        stored = resumed;
        await resync();
        await vi.waitFor(() => expect(observed.at(-1)).toEqual({ status: 'current', schedule: resumed }));
        stored = null;
        await resync();
        await vi.waitFor(() => expect(observed.at(-1)).toEqual({ status: 'stale', schedule: null }));
    }
    finally {
        stop();
        await facade.disconnect();
    }
});

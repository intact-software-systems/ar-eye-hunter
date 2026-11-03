import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';

import { installFakeBroadcastChannelPerTest } from '../../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime,
    seedRoomSnapshots
} from '../room-workflow-test-runtime.ts';

const runtime = getRoomWorkflowMocks();
installFakeBroadcastChannelPerTest();
const source = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'previous' };
const destination = { ...source, groupId: 'destination' };
const move: GroupMove = {
    moveId: 'move-1',
    source,
    destination,
    organizerSessionId: 'session-1',
    participants: [{
        principalId: 'principal-1',
        sessionId: 'session-1',
        generationId: 'generation-session-1',
        generationVersion: 100,
        confirmedAtEpochMs: 110,
        arrivedAtEpochMs: null
    }],
    createdAtEpochMs: 100,
    expiresAtEpochMs: 120100,
    completedAtEpochMs: 120,
    status: 'committed',
    reason: null,
    admissionFailure: null
};

describe('activating an admitted group move', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: '' });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('connects destination presence and disconnects source without removing either membership', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous]);
        const requests: { path: string; method: string; }[] = [];
        vi.stubGlobal(
            'fetch',
            async (url: string, init: RequestInit) => {
                requests.push({ path: String(url), method: String(init.method) });
                const generationId = requireRecord(JSON.parse(String(init.body)), 'Presence request').generationId;
                requireString(generationId, 'generationId');
                const snapshot = String(url).includes('/previous/')
                    ? { ...previous, activeSessions: [], onlineMemberCount: 0 }
                    : createRoomSnapshot('destination', ['session-1']);
                return new Response(
                    JSON.stringify({
                        ...snapshot,
                        group: { ...snapshot.group, presenceVersion: 2 },
                        causalRevision: { ...snapshot.causalRevision, presenceRevision: 2 },
                        activeSessions: snapshot.activeSessions.map((session) => ({
                            ...session,
                            expiresAtEpochMs: Date.now() + 120000,
                            generationId
                        }))
                    }),
                    { status: 200 }
                );
            }
        );
        const facade = createRallarFacade();
        const selectedRooms: (string | undefined)[] = [];
        const unsubscribe = facade.rooms.onChange((state) => {
            selectedRooms.push(state.currentRoomRef?.groupId);
        });
        await facade.rooms.activateMove(move);
        expect(requests.map((request) => request.method)).toEqual(['PUT', 'POST']);
        expect(requests[0].path).toContain('/groups/destination/sessions/session-1/requests/');
        expect(requests[1].path).toContain('/groups/previous/sessions/session-1/disconnect/requests/');
        expect(facade.rooms.current()?.group.groupId).toBe('destination');
        expect(runtime.leaveStateGroup).not.toHaveBeenCalled();
        expect(facade.rooms.session(source).snapshot()?.members).toEqual(previous.members);
        expect(facade.rooms.session(source).snapshot()?.activeSessions).toEqual([]);
        expect(facade.rooms.session(destination).snapshot()?.members).toEqual(createRoomSnapshot('destination', ['session-1']).members);
        expect(selectedRooms.filter((room, index) => index === 0 || room !== selectedRooms[index - 1]))
            .toEqual(['previous', 'destination']);
        unsubscribe();
    });

    it('keeps the current third room unchanged when an old move is explicitly retried', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        seedRoomSnapshots([createRoomSnapshot('third-room', ['session-1'])]);
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const facade = createRallarFacade();
        await expect(facade.rooms.activateMove(move)).rejects.toThrow(/Return to.*previous/);
        expect(facade.rooms.current()?.group.groupId).toBe('third-room');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('waits for destination presence before disconnecting the source and acknowledging arrival', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const previous = createRoomSnapshot('previous', ['session-1']);
        seedRoomSnapshots([previous]);
        const methods: string[] = [];
        let destinationGeneration = '';
        vi.stubGlobal(
            'fetch',
            async (url: string, init: RequestInit) => {
                const method = String(init.method);
                methods.push(method);
                const source = String(url).includes('/previous');
                const snapshot = source
                    ? { ...previous, activeSessions: [], onlineMemberCount: 0 }
                    : createRoomSnapshot('destination', method === 'GET' ? ['session-1'] : []);
                if (method === 'PUT') {
                    const generationId = requireRecord(JSON.parse(String(init.body)), 'Presence request').generationId;
                    requireString(generationId, 'generationId');
                    destinationGeneration = generationId;
                    expect(destinationGeneration).not.toBe(runtime.context.middleware.heartbeat.generationId);
                }
                const response = {
                    ...snapshot,
                    group: { ...snapshot.group, presenceVersion: method === 'GET' || source ? 2 : 1 },
                    activeSessions: snapshot.activeSessions.map((session) => ({
                        ...session,
                        expiresAtEpochMs: Date.now() + 120000,
                        generationId: destinationGeneration
                    })),
                    causalRevision: { ...snapshot.causalRevision, presenceRevision: method === 'GET' || source ? 2 : 1 }
                };
                return new Response(JSON.stringify(response), {
                    status: 200,
                    headers: {
                        'Cache-Control': 'no-store',
                        'rallar-state-source': 'durable',
                        'rallar-group-revision': String(response.causalRevision.groupRevision),
                        'rallar-presence-revision': String(response.causalRevision.presenceRevision)
                    }
                });
            }
        );
        const facade = createRallarFacade();
        await facade.rooms.activateMove(move);
        expect(methods).toEqual(['PUT', 'GET', 'POST']);
        expect(facade.rooms.current()?.group.groupId).toBe('destination');
    });

    it('keeps the source selected when destination presence fails', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        seedRoomSnapshots([createRoomSnapshot('previous', ['session-1'])]);
        vi.stubGlobal('fetch', async () => new Response('Unavailable', { status: 503 }));
        const facade = createRallarFacade();
        await expect(facade.rooms.activateMove(move, { maxAttempts: 1 })).rejects.toThrow();
        expect(facade.rooms.current()?.group.groupId).toBe('previous');
        expect(runtime.leaveStateGroup).not.toHaveBeenCalled();
    });

    it('refuses an uncommitted or other-account move before any HTTP effect', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        seedRoomSnapshots([createRoomSnapshot('previous', ['session-1'])]);
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const facade = createRallarFacade();
        await expect(facade.rooms.activateMove({ ...move, status: 'proposed', completedAtEpochMs: null })).rejects.toThrow();
        await expect(facade.rooms.activateMove({ ...move, participants: move.participants.map((participant) => ({ ...participant, principalId: 'another' })) }))
            .rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
});

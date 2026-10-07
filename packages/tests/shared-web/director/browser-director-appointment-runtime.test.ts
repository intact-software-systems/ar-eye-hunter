import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { BrowserDirectorAppointmentRuntime } from '@shared-web/browser/director/browser-director-appointment-runtime.ts';
import { BrowserDirectorStatusRuntime } from '@shared-web/browser/director/browser-director-status-runtime.ts';
import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import { updateStateGroupMetadata } from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import type { RallarStateCacheReadPort } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const scope = { applicationId: 'arena', workspaceId: 'default' };
const roomRef = { ...scope, groupId: 'room' };
const session: AuthSession = {
    clientId: 'hunter',
    sessionId: 'hunter',
    username: 'hunter',
    accessToken: 'fixture-token',
    expiresAtEpochMs: 60_000
};

class AppointedRoomCache implements RallarStateCacheReadPort {
    private readonly snapshot: GroupSnapshot;

    constructor(snapshot: GroupSnapshot) {
        this.snapshot = snapshot;
    }

    readGroupSnapshots(): readonly GroupSnapshot[] {
        return [this.snapshot];
    }
    findGroupSnapshotByRef(): GroupSnapshot | undefined {
        return this.snapshot;
    }
    findFirstGroupRefForSession() {
        return this.snapshot.group;
    }
    wasGroupSnapshotObserved(): boolean {
        return true;
    }
    readClientSnapshots() {
        return [];
    }
    findClientSnapshot() {
        return undefined;
    }
    onCacheChange() {
        return () => {};
    }
}

describe('director resignation', () => {
    const sentBodies: object[] = [];

    beforeEach(() => {
        sentBodies.length = 0;
        configureApiClient({ apiBaseUrl: '' });
        vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends room metadata without the appointment, keeping every other key, through the metadata update workflow', async () => {
        const appointed = createAppointmentSnapshot();
        stubGroupState(appointed);
        const runtime = createAppointmentRuntime(appointed);

        await runtime.resign(roomRef);

        expect(sentBodies).toEqual([expect.objectContaining({ metadata: { keep: true } })]);
    });

    function stubGroupState(stored: GroupSnapshot): void {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                if ((init?.method ?? 'GET') === 'GET') {
                    return toGroupPointResponse(stored);
                }
                const body = JSON.parse(String(init?.body)) as { metadata: GroupSnapshot['group']['metadata']; };
                sentBodies.push(body);
                return toJsonResponse({ ...stored, group: { ...stored.group, metadata: body.metadata } });
            })
        );
    }
});

function createAppointmentRuntime(snapshot: GroupSnapshot): BrowserDirectorAppointmentRuntime {
    const roomStateStore = createRoomStateStore({
        runtime: {
            currentRoomRef: () => undefined,
            setCurrentRoom: () => {},
            clearCurrentRoomIfMatches: () => {},
            readDefaultScope: () => scope,
            resolveOperationScope: () => scope
        },
        readSession: () => session,
        stateCache: new AppointedRoomCache(snapshot)
    });
    const rooms: Pick<BrowserRallarRooms, 'updateMetadata'> = {
        updateMetadata: async (room, patch) =>
            await updateStateGroupMetadata({
                groupId: typeof room === 'string' ? room : room.groupId,
                patch,
                principalId: session.clientId,
                sessionId: session.sessionId,
                scope
            })
    };
    return new BrowserDirectorAppointmentRuntime({
        roomStateStore,
        rooms: rooms as BrowserRallarRooms,
        status: new BrowserDirectorStatusRuntime({
            roomStateStore,
            nowMs: () => 1_234,
            readSession: () => session,
            resolveDefaultRoom: () => undefined
        }),
        requireSession: () => session,
        connect: async () => {
            throw new Error('A resignation never connects.');
        },
        resolveOperationOptions: (options) => options,
        resolveDefaultRoom: () => undefined,
        runAuthAwareOperation: async (operation) => await operation(),
        acceptSnapshots: async () => {}
    });
}

function createAppointmentSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['hunter'] });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            metadata: {
                keep: true,
                rallarDirector: {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'hunter',
                    principalId: 'hunter',
                    epoch: 1,
                    appointedAtEpochMs: 1_000,
                    heartbeatTtlMs: 5_000
                }
            }
        }
    };
}

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

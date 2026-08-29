// dprint-ignore
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { refreshBlackBoxBrowserRoomState } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { AuditStamp, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { findAcceptedOverlayById, findPlannedOverlayById } from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

import { configureTestCacheRepositories } from '../../cache-repository-config.ts';
import { createTestGroup } from '../../create-test-group.ts';

const scope: StateScope = {
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID
};

const authSession: AuthSession = {
    clientId: 'session-a',
    accessToken: 'test-token',
    username: 'alice',
    sessionId: 'session-a',
    expiresAtEpochMs: Date.now() + 60_000
};

interface TestTopologyView {
    readonly groupRef: GroupRef;
    readonly overlayId: string;
    readonly snapshot: RallarOverlayTopologySnapshot | null;
    readonly acceptedSnapshot: RallarOverlayTopologySnapshot | null;
    readonly config: null;
    readonly pending: null;
}

describe('black-box browser room-state refresh composition', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('enforces one caller deadline across a stalled topology hydration', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const stalledFetch = vi.fn(
            (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => undefined)
        );
        vi.stubGlobal('fetch', stalledFetch);

        const refresh = refreshBlackBoxBrowserRoomState({
            ...createRefreshInput(group),
            options: { scope, timeoutMs: 5 }
        });

        await expect(refresh).rejects.toMatchObject({
            name: 'TimeoutError',
            message: 'Room state refresh timed out after 5 ms.'
        });
        expect(stalledFetch).toHaveBeenCalledOnce();
        expect(stalledFetch.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
    });

    it('rejects caller cancellation even when topology hydration classifies abort as read-failed', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const stalledFetch = vi.fn(
            (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => undefined)
        );
        vi.stubGlobal('fetch', stalledFetch);
        const controller = new AbortController();
        const reason = new Error('caller cancelled room refresh');
        const refresh = refreshBlackBoxBrowserRoomState({
            ...createRefreshInput(group),
            options: { scope, signal: controller.signal, timeoutMs: 1_000 }
        });
        await vi.waitFor(() => expect(stalledFetch).toHaveBeenCalledOnce());

        controller.abort(reason);

        await expect(refresh).rejects.toBe(reason);
    });

    it('removes the private abort-race listener after a successful refresh', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse(topologyView(group, null, null)))
        );
        const addEventListener = vi.spyOn(AbortSignal.prototype, 'addEventListener');
        const removeEventListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

        await refreshBlackBoxBrowserRoomState({
            ...createRefreshInput(group),
            options: { scope, timeoutMs: 1_000 }
        });

        const abortRegistration = addEventListener.mock.calls.find(([event]) => event === 'abort');
        expect(abortRegistration).toBeDefined();
        expect(removeEventListener).toHaveBeenCalledWith(
            'abort',
            abortRegistration?.[1]
        );
    });

    it('hydrates and clears both topology roles through the production refresh operation', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const planned = createTopologySnapshot(group, 4);
        const accepted = createTopologySnapshot(group, 3);
        const responses: TestTopologyView[] = [
            topologyView(group, planned, accepted),
            topologyView(group, null, null)
        ];
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(nextTopologyView(responses))));
        const input = createRefreshInput(group);

        await refreshBlackBoxBrowserRoomState({
            ...input,
            options: { scope, timeoutMs: 1_000 }
        });

        const overlayId = toScopedOverlayId(group.group);
        expect(findPlannedOverlayById(overlayId)?.overlayVersion).toBe(4);
        expect(findAcceptedOverlayById(overlayId)?.overlayVersion).toBe(3);

        await refreshBlackBoxBrowserRoomState({
            ...input,
            options: { scope, timeoutMs: 1_000 }
        });

        expect(findPlannedOverlayById(overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
    });
});

function createRefreshInput(group: GroupSnapshot) {
    const manager = createWebRtcGroupManager();
    return {
        roomRef: group.group,
        rooms: {
            session: vi.fn(() => ({
                refresh: vi.fn(async () => ({ snapshot: () => group }))
            }))
        },
        session: {
            connect: vi.fn(async () => ({
                session: authSession,
                middleware: { webRtcGroupManager: manager }
            }))
        }
    } as const;
}

function createWebRtcGroupManager(): WebRtcGroupManager {
    return {
        notifyOverlayTopologyChanged: vi.fn(async () => undefined)
    } as never;
}

function jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function nextTopologyView(responses: TestTopologyView[]): TestTopologyView {
    const response = responses.shift();
    if (!response) {
        throw new Error('Topology response fixture was exhausted.');
    }
    return response;
}

function topologyView(
    group: GroupSnapshot,
    snapshot: RallarOverlayTopologySnapshot | null,
    acceptedSnapshot: RallarOverlayTopologySnapshot | null
): TestTopologyView {
    return {
        groupRef: groupRefOf(group),
        overlayId: toScopedOverlayId(group.group),
        snapshot,
        acceptedSnapshot,
        config: null,
        pending: null
    };
}

function createGroupSnapshot(): GroupSnapshot {
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            groupId: 'room-a',
            displayName: 'room-a',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: auditStamp(),
            updated: auditStamp(),
            activeMemberCount: 2,
            ownerPrincipalId: 'session-a'
        }),
        members: [],
        activeSessions: ['session-a', 'session-b'].map((sessionId) => ({
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            groupId: 'room-a',
            sessionId,
            principalId: sessionId,
            generationId: 'generation-1',
            generationVersion: 1,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: Date.now() + 120_000
        })),
        memberCount: 2,
        onlineMemberCount: 2
    };
}

function createTopologySnapshot(
    group: GroupSnapshot,
    version: number
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: group.causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: groupRefOf(group),
        name: group.group.displayName,
        topology: 'mesh',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a']
        },
        degreeLimit: 1,
        version,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: version
    };
}

function groupRefOf(group: GroupSnapshot): GroupRef {
    return {
        applicationId: group.group.applicationId,
        workspaceId: group.group.workspaceId,
        groupId: group.group.groupId
    };
}

function auditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

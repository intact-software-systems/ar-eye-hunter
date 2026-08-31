import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
// dprint-ignore
import {
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { findPlannedOverlayById, setPlannedOverlayById } from '@shared/repository/overlays-repository.ts';
// dprint-ignore
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createGroupSnapshot,
    createGroupStateDeltaEnvelope,
    createWebRtcGroupManager,
    groupSnapshotResponse
} from './browser-state-cache-lifecycle-fixtures.ts';

describe('browser state cache delta recovery and bootstrap topology', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('pulls the floored group snapshot when a delta envelope arrives over a causal gap', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        let onInboxMessage:
            | ((message: ALMessage) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: ALMessage) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            })
        };
        const listener = vi.fn();
        const unsubscribe = browserStateCacheLifecycle.onChange(listener);
        const resulting = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a'],
            snapshotVersion: 2
        });
        const envelope = createGroupStateDeltaEnvelope(
            resulting,
            { groupRevision: 1, presenceRevision: 1 }
        );
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        vi.stubGlobal('localStorage', { getItem: () => null });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => groupSnapshotResponse(resulting));
        vi.stubGlobal('fetch', fetchMock);

        browserStateCacheLifecycle.initialise({
            inbox: webSocketQueueBox,
            webRtcGroupManager: manager as never,
            clientData
        });

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'room-a', envelope.event.eventId),
                'all',
                AppTopics.groupStateEvent,
                envelope
            )
        );

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
            'https://api.example.test/api/state/apps/rallar-server/workspaces/default' +
                '/groups/room-a?minGroupRevision=2&minPresenceRevision=2'
        );
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots()
        ).toEqual([resulting]);
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [resulting]
        });

        vi.unstubAllGlobals();
        unsubscribe();
    });

    it('creates a bounded bootstrap overlay for active group snapshots', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        const memberSessionIds = Array.from(
            { length: 8 },
            (_, index) => `session-${String.fromCharCode(97 + index)}`
        );
        const group = createGroupSnapshot({
            groupId: 'room-bootstrap',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: memberSessionIds,
            snapshotVersion: 1
        });

        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [group]
        });

        const overlay = findPlannedOverlayById(toScopedOverlayId(group.group));
        expect(overlay).toMatchObject({
            provenance: 'bootstrap',
            topology: 'star',
            degreeLimit: 5
        });
        expect(overlay?.nextHopSessionIds).toHaveLength(5);
        expect(overlay?.nextHopSessionIds).not.toContain('session-a');
    });

    it('does not restamp a bootstrap overlay over an existing server overlay', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        const group = createGroupSnapshot({
            groupId: 'room-server-owned',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a', 'session-b', 'session-c'],
            snapshotVersion: 1
        });
        const overlayId = toScopedOverlayId(group.group);
        setPlannedOverlayById(overlayId, {
            sourceGroupStateCausalRevision: {
                groupRevision: 1,
                presenceRevision: 1
            },
            provenance: 'server',
            state: 'active',
            overlayId,
            groupRef: group.group,
            topology: 'tree',
            name: 'room-server-owned',
            createdByClientId: 'server',
            createdAtEpochMs: 1,
            nextHopSessionIds: ['session-c'],
            degreeLimit: 5,
            overlayVersion: 1,
            updatedAtEpochMs: 1
        });

        const newerGroup = createGroupSnapshot({
            groupId: 'room-server-owned',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a', 'session-b', 'session-c'],
            snapshotVersion: 5
        });
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [newerGroup]
        });

        expect(findPlannedOverlayById(overlayId)).toMatchObject({
            provenance: 'server',
            topology: 'tree',
            nextHopSessionIds: ['session-c']
        });
    });
});

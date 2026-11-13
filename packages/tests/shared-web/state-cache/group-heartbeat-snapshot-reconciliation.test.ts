import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { adoptGroupSnapshotsFromHeartbeat } from '@shared-web/browser/state-cache/group-heartbeat-snapshot-adoption.ts';
import { createPassThroughGroupStateAppliedRevisionSink } from '@shared/repository/group-state-applied-revision.ts';
import {
    setBrowserStateReadDiagnosticsSink,
    type BrowserStateReadDiagnosticEvent
} from '@shared-web/browser/state-read/diagnostics.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshot, createWebRtcGroupManager } from './browser-state-cache-lifecycle-fixtures.ts';

/** One sink per file, so a connect's initialise and hydrate match as the middleware's do. */
const passThroughGroupStateDiagnostics = createPassThroughGroupStateAppliedRevisionSink();

describe('group heartbeat snapshot reconciliation', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('reconciles a removed peer when the surviving session lease advances at the same causal revision', async () => {
        const now = Date.now();
        const group = createGroupSnapshot({
            groupId: 'heartbeat-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion: 1
        });
        const observed = {
            ...group,
            activeSessions: group.activeSessions.map((session) => ({
                ...session,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: now + 60_000
            }))
        };
        const returned = {
            ...observed,
            activeSessions: [{
                ...observed.activeSessions[0]!,
                lastHeartbeatAtEpochMs: now + 1_000,
                expiresAtEpochMs: now + 120_000
            }],
            onlineMemberCount: 1
        };
        const manager = createWebRtcGroupManager();
        const listener = vi.fn();
        const unsubscribe = browserStateCacheLifecycle.onChange(listener);

        try {
            await browserStateCacheLifecycle.hydrate({
                groupStateDiagnostics: passThroughGroupStateDiagnostics,
                webRtcGroupManager: manager,
                clientData: { clientId: 'session-a', sessionId: 'session-a', isOnline: true },
                clientSnapshots: [],
                groupSnapshots: [observed],
                options: { scope: { applicationId: 'app-1', workspaceId: 'workspace-b' } }
            });
            manager.acceptGroupUpdate.mockClear();
            listener.mockClear();

            adoptGroupSnapshotsFromHeartbeat([observed], [returned]);
            await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

            expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(group.group)).toBe(returned);
            expect(manager.acceptGroupUpdate).toHaveBeenCalledWith(returned);
            expect(listener).toHaveBeenCalledWith({ clients: [], groups: [returned] });
        }
        finally {
            unsubscribe();
        }
    });

    it('adopts the server\'s snapshot when the cached one holds other content at the same causal revision', async () => {
        const group = createGroupSnapshot({
            groupId: 'heartbeat-divergent-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-a', 'session-b', 'session-c'],
            snapshotVersion: 5
        });
        const grantOf = (principalId: string) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            groupId: 'heartbeat-divergent-room',
            principalId,
            topics: { 'room.feed': { publish: true, subscribe: false } },
            updated: group.group.updated
        });
        const observed = { ...group, publicationGrants: [grantOf('session-b')] };
        const returned = { ...group, publicationGrants: [grantOf('session-b'), grantOf('session-c')] };
        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: createWebRtcGroupManager(),
            clientData: { clientId: 'session-a', sessionId: 'session-a', isOnline: true },
            clientSnapshots: [],
            groupSnapshots: [observed],
            options: { scope: { applicationId: 'app-1', workspaceId: 'workspace-b' } }
        });

        const diagnostics: BrowserStateReadDiagnosticEvent[] = [];
        setBrowserStateReadDiagnosticsSink((event) => diagnostics.push(event));

        try {
            expect(() => adoptGroupSnapshotsFromHeartbeat([observed], [returned])).not.toThrow();
            await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
        }
        finally {
            setBrowserStateReadDiagnosticsSink(undefined);
        }

        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(group.group)).toEqual(returned);
        expect(diagnostics).toEqual([{
            name: 'rallar.browser.state-read',
            feature: 'group',
            operation: 'heartbeat',
            result: 'revision-conflict',
            durationMs: 0
        }]);
    });
});

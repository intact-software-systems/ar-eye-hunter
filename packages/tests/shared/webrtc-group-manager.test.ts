// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';

import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
// dprint-ignore
import type {
    AuditStamp,
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import type { WebRtcGroupPeerSelection } from '@shared/services/webrtc-group-manager-contracts.ts';
import { createTestGroup } from '../create-test-group.ts';
import { createSimulatedRtcConnections } from './simulated-rtc-connection-service.ts';

interface GroupSnapshotFixture {
    readonly groupId: string;
    readonly membershipVersion: number;
    readonly memberSessionIds: readonly string[];
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

interface RtcConnectionHarness {
    readonly service: WebRtcConnectionService;
    knownPeerIds(): string[];
    peerIdsWithNoReconnectableLanes(): string[];
    markReconnectable(peerId: string): boolean;
}

describe('WebRtcGroupManager', () => {
    it('notifies with final desired and canonical degree-limited RTT peers after dial reconciliation', async () => {
        const rtcQBox = createRtcConnectionHarness('session-b');
        const notifications: ReconciledPeerSelectionObservation[] = [];
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(rtcQBox.service, {
            groupCache: new LatestRepository<string, GroupSnapshot>(),
            clientCache: new LatestRepository<string, ClientInfo>(),
            acceptedOverlayCache
        }, {
            rttReportingDegreeLimit: 1,
            onDesiredPeerIdsChanged: (selection) =>
                notifications.push({
                    ...selection,
                    knownPeerIds: rtcQBox.knownPeerIds()
                })
        });
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'room',
                membershipVersion: 1,
                memberSessionIds: ['session-a', 'session-b', 'session-c', 'session-d']
            })
        );
        expect(notifications).toEqual([{
            desiredPeerIds: ['session-a', 'session-c', 'session-d'],
            rttReportingPeerIds: ['session-d'],
            knownPeerIds: ['session-a', 'session-c', 'session-d']
        }]);
    });

    it('dials group-present peers before the global client cache converges', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('local');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['local', 'peer-a'] })
        );

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a']);
        expect(manager.rttReportingPeerIds({ degreeLimit: 1 })).toEqual(['peer-a']);
        expect(manager.state()).toMatchObject({
            onlinePeerIds: [],
            onlineDesiredPeerIds: [],
            connectablePeerIds: ['peer-a']
        });
    });

    it('does not dial a stale accepted peer absent from current group presence', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );
        const group = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self'] });
        const otherGroup = createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['self', 'peer-stale'] });
        acceptedOverlayCache.set(
            toScopedOverlayId(group.group),
            createOverlayInfo(group, ['peer-stale'])
        );
        acceptedOverlayCache.set(
            toScopedOverlayId(otherGroup.group),
            createOverlayInfo(otherGroup, [])
        );
        clientCache.set('peer-stale', createClientInfo('peer-stale', true));

        await manager.acceptGroupUpdate(group);
        await manager.acceptGroupUpdate(otherGroup);

        expect(manager.state()).toMatchObject({
            desiredPeerIds: ['peer-stale'],
            onlineDesiredPeerIds: ['peer-stale'],
            connectablePeerIds: []
        });
        expect(rtcQBox.knownPeerIds()).toEqual([]);
        expect(manager.isPeerDialAllowedByAnyGroup('peer-stale')).toBe(false);
    });

    it('invalidates dial permission when presence leaves an unchanged accepted layout', async () => {
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const connection = createRtcConnectionHarness('self');
        const manager = new WebRtcGroupManager(connection.service, {
            groupCache: new LatestRepository<string, GroupSnapshot>(),
            clientCache: new LatestRepository<string, ClientInfo>(),
            acceptedOverlayCache
        }, { overlayTransitionGraceMs: 0 });
        const group = createGroupSnapshot({
            groupId: 'room',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-a']
        });
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, group);
        expect(manager.isPeerDialAllowedByAnyGroup('peer-a')).toBe(true);

        await manager.acceptGroupUpdate({
            ...group,
            group: { ...group.group, presenceVersion: 2 },
            causalRevision: { groupRevision: 1, presenceRevision: 2 },
            activeSessions: group.activeSessions.filter((session) => session.sessionId === 'self'),
            onlineMemberCount: 1
        });

        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['room']);
        expect(manager.isPeerDialAllowedByAnyGroup('peer-a')).toBe(false);
        expect(connection.knownPeerIds()).toEqual(['peer-a']);
    });

    it('reports global online state separately from group-scoped connectability', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self', ['peer-orphan']);
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', false));
        clientCache.set('peer-c', createClientInfo('peer-c', true));

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a', 'peer-b'] })
        );
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['self', 'peer-a', 'peer-c'] })
        );

        expect(rtcQBox.knownPeerIds().sort()).toEqual(['peer-a', 'peer-b', 'peer-c']);
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['group-1', 'group-2']);
        expect(manager.isPeerDialAllowedByAnyGroup('peer-b')).toBe(true);

        expect(manager.state()).toEqual({
            groupIds: ['group-1', 'group-2'],
            desiredPeerIds: ['peer-a', 'peer-b', 'peer-c'],
            onlinePeerIds: ['peer-a', 'peer-c'],
            onlineDesiredPeerIds: ['peer-a', 'peer-c'],
            connectablePeerIds: ['peer-a', 'peer-b', 'peer-c'],
            peerIdsWithNoReconnectableLanes: ['peer-a', 'peer-b', 'peer-c'],
            peerOwners: new Map([
                ['peer-a', ['group-1', 'group-2']],
                ['peer-b', ['group-1']],
                ['peer-c', ['group-2']]
            ])
        });
    });

    it('reads online peers once when materializing manager state', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new CountingClientCache();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));
        clientCache.set('peer-c', createClientInfo('peer-c', false));

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'group-1',
                membershipVersion: 1,
                memberSessionIds: [
                    'self',
                    'peer-a',
                    'peer-b',
                    'peer-c'
                ]
            })
        );

        clientCache.resetCounters();

        expect(manager.state()).toMatchObject({
            onlinePeerIds: ['peer-a', 'peer-b'],
            onlineDesiredPeerIds: ['peer-a', 'peer-b']
        });
        expect(clientCache.keysCalls).toBe(1);
    });

    it('updates cached peer owners after group membership changes', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] })
        );

        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['group-1']);
        expect(manager.isPeerDialAllowedByAnyGroup('peer-b')).toBe(false);

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 2, memberSessionIds: ['self', 'peer-b'] })
        );

        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual([]);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual(['group-1']);
        expect(manager.isPeerDialAllowedByAnyGroup('peer-b')).toBe(true);
    });

    it('does not duplicate reconciliations once sync start records a peer', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));

        const first = acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] })
        );
        const second = manager.ensureAllGroupsConnected();
        const third = manager.notifyClientPresenceChanged();

        await Promise.all([first, second, third]);

        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-a']);
    });

    it('tracks same group id snapshots from different workspaces independently', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'shared-room',
                membershipVersion: 1,
                memberSessionIds: ['self', 'peer-a'],
                workspaceId: 'workspace-a'
            })
        );
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'shared-room',
                membershipVersion: 1,
                memberSessionIds: ['self', 'peer-b'],
                workspaceId: 'workspace-b'
            })
        );

        expect(manager.size()).toBe(2);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes().sort()).toEqual(['peer-a', 'peer-b']);
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['shared-room']);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual(['shared-room']);
    });

    it('deletes only the matching scoped group when same group id exists in multiple workspaces', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );
        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-a'],
            workspaceId: 'workspace-a'
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-b'],
            workspaceId: 'workspace-b'
        });

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, workspaceA);
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, workspaceB);

        await expect(manager.delete(workspaceA.group)).resolves.toBe(true);

        expect(manager.size()).toBe(1);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-b']);
        expect(manager.getIfPresent(workspaceA.group)).toBeUndefined();
        expect(manager.getIfPresent(workspaceB.group)?.targetPeerIds()).toEqual(['peer-b']);
    });

    it('disconnects peers when groups are deleted or cleared', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        const group1 = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] });
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, group1);

        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-a']);

        await expect(manager.delete(group1.group)).resolves.toBe(true);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual([]);

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] })
        );
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-a']);

        await manager.clear();

        expect(manager.size()).toBe(0);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual([]);
    });

    it('disconnects stale known peers when they leave all groups', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self', ['peer-a']);
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] })
        );

        rtcQBox.markReconnectable('peer-a');
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 2, memberSessionIds: ['self'] })
        );

        expect(rtcQBox.knownPeerIds()).toEqual([]);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual([]);
    });

    it('retains left-room peers below the inactive connection budget', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        const group = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] });
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, group);

        await expect(manager.delete(group.group, { retainConnections: true }))
            .resolves.toBe(true);

        expect(manager.size()).toBe(0);
        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a']);
    });

    it('evicts the oldest retained inactive peers when the connection budget is exceeded', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { maxPeerConnections: 5, overlayTransitionGraceMs: 0 }
        );
        const retainedPeerIds = ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'];

        for (const peerId of [...retainedPeerIds, 'peer-f']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        const oldGroup = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'self',
                ...retainedPeerIds
            ]
        });
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, oldGroup);
        await manager.delete(oldGroup.group, { retainConnections: true });

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['self', 'peer-f'] })
        );

        expect(rtcQBox.knownPeerIds().sort()).toEqual([
            'peer-b',
            'peer-c',
            'peer-d',
            'peer-e',
            'peer-f'
        ]);
    });

    it('selects at most the configured RTT reporting peers from bootstrap room peers', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('local');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        for (const peerId of ['peer-a', 'peer-b', 'peer-c', 'peer-d']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        await manager.acceptGroupUpdate(
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['local', 'peer-a', 'peer-b', 'peer-c', 'peer-d'] })
        );

        const selected = manager.rttReportingPeerIds({ degreeLimit: 2 });

        expect(selected).toHaveLength(2);
        expect(selected).not.toContain('local');
    });

    it('assigns an RTT pair to only the canonical browser reporter', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const sessionAManager = new WebRtcGroupManager(
            createRtcConnectionHarness('session-a').service,
            { groupCache, clientCache },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        const sessionBManager = new WebRtcGroupManager(
            createRtcConnectionHarness('session-b').service,
            { groupCache, clientCache },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        const group = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'session-a',
                'session-b'
            ]
        });
        clientCache.set('session-a', createClientInfo('session-a', true));
        clientCache.set('session-b', createClientInfo('session-b', true));

        await sessionAManager.acceptGroupUpdate(group);
        await sessionBManager.acceptGroupUpdate(group);

        expect(sessionAManager.rttReportingPeerIds({ degreeLimit: 1 }))
            .toEqual(['session-b']);
        expect(sessionBManager.rttReportingPeerIds({ degreeLimit: 1 }))
            .toEqual([]);
    });

    it('prefers overlay next hops for RTT reporting selection', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtcQBox = createRtcConnectionHarness('local');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            {
                groupCache,
                clientCache,
                plannedOverlayCache
            },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        const group = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'local',
                'peer-a',
                'peer-b',
                'peer-c'
            ]
        });
        for (const peerId of ['peer-a', 'peer-b', 'peer-c']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        plannedOverlayCache.set(toScopedOverlayId(group.group), {
            ...createOverlayInfo(group, ['peer-c']),
            degreeLimit: 1
        });
        await manager.acceptGroupUpdate(group);

        expect(manager.rttReportingPeerIds({ degreeLimit: 1 })).toEqual(['peer-c']);
    });

    it('uses complete star overlays for RTT bootstrap selection', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtcQBox = createRtcConnectionHarness('local');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            {
                groupCache,
                clientCache,
                plannedOverlayCache
            },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        const group = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'local',
                'peer-a',
                'peer-b',
                'peer-c'
            ]
        });
        for (const peerId of ['peer-a', 'peer-b', 'peer-c']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        plannedOverlayCache.set(toScopedOverlayId(group.group), {
            ...createOverlayInfo(group, ['peer-a']),
            topology: 'star'
        });
        await manager.acceptGroupUpdate(group);

        expect(manager.rttReportingPeerIds({ degreeLimit: 1 })).toEqual(['peer-a']);
    });

    it('uses server-compatible per-group bootstrap candidates for RTT reporting', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('local');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        for (
            const peerId of [
                'peer-a',
                'peer-b',
                'peer-c',
                'peer-ax',
                'peer-bx',
                'peer-cx'
            ]
        ) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        await manager.acceptGroupUpdate(
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['local', 'peer-a', 'peer-b', 'peer-c'] })
        );
        await manager.acceptGroupUpdate(
            createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['local', 'peer-ax', 'peer-bx', 'peer-cx'] })
        );

        const selected = manager.rttReportingPeerIds({ degreeLimit: 1 });

        expect(selected).toHaveLength(1);
        expect(selected).not.toContain('peer-cx');
        expect(['peer-b', 'peer-c', 'peer-bx']).toContain(selected[0]);
    });

    it('does not report RTT peers rejected by another shared active group', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('local');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        for (const peerId of ['peer-a', 'peer-b', 'peer-c']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        await manager.acceptGroupUpdate(
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['local', 'peer-a', 'peer-b', 'peer-c'] })
        );
        await manager.acceptGroupUpdate(
            createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['local', 'peer-a', 'peer-b', 'peer-c'] })
        );

        expect(manager.rttReportingPeerIds({ degreeLimit: 1 })).toEqual([]);
    });

    it('uses overlay degree limit as RTT reporting fallback', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtcQBox = createRtcConnectionHarness('local');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            {
                groupCache,
                clientCache,
                plannedOverlayCache
            }
        );
        const group = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'local',
                'peer-a',
                'peer-b',
                'peer-c'
            ]
        });
        for (const peerId of ['peer-a', 'peer-b', 'peer-c']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        plannedOverlayCache.set(
            toScopedOverlayId(group.group),
            {
                ...createOverlayInfo(group, ['peer-a', 'peer-b', 'peer-c']),
                degreeLimit: 2
            }
        );
        await manager.acceptGroupUpdate(group);

        expect(manager.rttReportingPeerIds()).toHaveLength(2);
    });

    it('uses overlay next hops as desired RTC peers when topology is available', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            {
                groupCache,
                clientCache,
                acceptedOverlayCache
            },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        const group = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'self',
                'peer-a',
                'peer-b',
                'peer-c'
            ]
        });
        const overlayId = toScopedOverlayId(group.group);

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));
        clientCache.set('peer-c', createClientInfo('peer-c', true));
        acceptedOverlayCache.set(overlayId, createOverlayInfo(group, ['peer-a']));

        await manager.acceptGroupUpdate(group);

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a']);
        expect(manager.state().desiredPeerIds).toEqual(['peer-a']);
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['group-1']);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual([]);

        acceptedOverlayCache.set(overlayId, createOverlayInfo(group, ['peer-b'], 2));
        await manager.notifyOverlayTopologyChanged();

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-b']);
        expect(manager.state().desiredPeerIds).toEqual(['peer-b']);
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual([]);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual(['group-1']);
    });

    it('counts reconcile runs, connects, and disconnects in diagnostics', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self', ['peer-orphan']);
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0 }
        );

        expect(manager.readDiagnostics()).toEqual({
            reconcileRunCount: 0,
            reconcileAwaitedInFlightCount: 0,
            reconcileCoalescedRerunCount: 0,
            lastDesiredPeerCount: 0,
            connectAttemptCount: 0,
            connectFailureCount: 0,
            connectDeferredBudgetCount: 0,
            disconnectCount: 0,
            retainedCreatedCount: 0,
            retainedExpiredCount: 0,
            retainedEvictionCount: 0
        });

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', false));

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a', 'peer-b'] })
        );

        const afterFirstReconcile = manager.readDiagnostics();
        expect(afterFirstReconcile.reconcileRunCount).toBe(1);
        expect(afterFirstReconcile.lastDesiredPeerCount).toBe(2);
        expect(afterFirstReconcile.connectAttemptCount).toBe(2);
        expect(afterFirstReconcile.connectFailureCount).toBe(0);
        expect(afterFirstReconcile.disconnectCount).toBe(1);

        const first = manager.ensureAllGroupsConnected();
        const second = manager.notifyClientPresenceChanged();
        await Promise.all([first, second]);

        const afterConcurrentReconcile = manager.readDiagnostics();
        // The concurrent trigger is coalesced, not lost: the awaiting caller
        // re-runs once against the newest state after the in-flight run.
        expect(afterConcurrentReconcile.reconcileRunCount).toBe(3);
        expect(afterConcurrentReconcile.reconcileAwaitedInFlightCount).toBe(1);
        // Re-ensuring a peer whose setup is still in flight starts no new attempt.
        expect(afterConcurrentReconcile.connectAttemptCount).toBe(2);

        manager.resetDiagnostics();
        expect(manager.readDiagnostics().reconcileRunCount).toBe(0);
    });

    it('caps outbound dials at the connection budget and counts deferrals', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { maxPeerConnections: 5, overlayTransitionGraceMs: 0 }
        );
        const peerIds = Array.from({ length: 8 }, (_, index) => `peer-${index}`);
        for (const peerId of peerIds) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', ...peerIds] })
        );

        expect(rtcQBox.knownPeerIds()).toHaveLength(5);
        expect(manager.readDiagnostics().connectDeferredBudgetCount).toBe(3);
    });

    it('does not spend the dial budget on peers without a selected accepted layout', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            {
                groupCache,
                clientCache,
                acceptedOverlayCache
            },
            { maxPeerConnections: 5, overlayTransitionGraceMs: 0 }
        );
        const bootstrapPeerIds = Array.from(
            { length: 6 },
            (_, index) => `peer-x${index + 1}`
        );
        const bootstrapGroup = createGroupSnapshot({
            groupId: 'group-boot',
            membershipVersion: 1,
            memberSessionIds: [
                'self',
                ...bootstrapPeerIds
            ]
        });
        const serverGroup = createGroupSnapshot({
            groupId: 'group-server',
            membershipVersion: 1,
            memberSessionIds: [
                'self',
                'peer-s1'
            ]
        });
        for (const peerId of ['peer-s1', ...bootstrapPeerIds]) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        acceptedOverlayCache.set(
            toScopedOverlayId(serverGroup.group),
            createOverlayInfo(serverGroup, ['peer-s1'])
        );

        await manager.acceptGroupUpdate(serverGroup);
        await manager.acceptGroupUpdate(bootstrapGroup);

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-s1']);
        expect(manager.readDiagnostics().connectDeferredBudgetCount).toBe(0);
    });

    it('counts connect failures in diagnostics', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const failingService = createSimulatedRtcConnections('self', () => {
            throw new Error('dial failed');
        }).service;
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            failingService,
            { groupCache, clientCache, acceptedOverlayCache }
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] })
        );

        const diagnostics = manager.readDiagnostics();
        expect(diagnostics.connectAttemptCount).toBe(1);
        expect(diagnostics.connectFailureCount).toBe(1);
    });

    it('counts retained peer evictions in diagnostics', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self', [], () => false);
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { maxPeerConnections: 5, overlayTransitionGraceMs: 0 }
        );
        const retainedPeerIds = ['peer-a', 'peer-b', 'peer-c', 'peer-d'];
        const replacementPeerIds = ['peer-e', 'peer-f', 'peer-g'];
        for (const peerId of [...retainedPeerIds, ...replacementPeerIds]) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        const oldGroup = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'self',
                ...retainedPeerIds
            ]
        });
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, oldGroup);
        expect(rtcQBox.knownPeerIds()).toHaveLength(4);
        await manager.delete(oldGroup.group, { retainConnections: true });

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['self', ...replacementPeerIds] })
        );

        const diagnostics = manager.readDiagnostics();
        expect(diagnostics.retainedEvictionCount).toBe(2);
        expect(rtcQBox.knownPeerIds()).toHaveLength(5);
    });
});

interface ReconciledPeerSelectionObservation extends WebRtcGroupPeerSelection {
    readonly knownPeerIds: readonly string[];
}

async function acceptActiveLayoutGroup(
    manager: WebRtcGroupManager,
    acceptedOverlayCache: LatestRepository<string, OverlayInfo>,
    group: GroupSnapshot
): Promise<void> {
    acceptedOverlayCache.set(
        toScopedOverlayId(group.group),
        createOverlayInfo(
            group,
            group.activeSessions
                .map((session) => session.sessionId)
                .filter((sessionId) => sessionId !== manager.rtcQBox.input.sessionId),
            group.group.snapshotVersion
        )
    );
    await manager.acceptGroupUpdate(group);
}

function createRtcConnectionHarness(
    sessionId: string,
    initiallyConnectedPeerIds: readonly string[] = [],
    connect?: (peerId: string) => boolean
): RtcConnectionHarness {
    const simulation = createSimulatedRtcConnections(sessionId, connect);
    const { service } = simulation;
    for (const peerId of initiallyConnectedPeerIds) {
        const result = service.ensurePeerConnectionStarted(peerId);
        if (result.left) {
            throw new Error(`Failed to seed simulated peer ${peerId}`);
        }
    }
    return {
        service,
        knownPeerIds: () => [...service.knownPeerIds()],
        peerIdsWithNoReconnectableLanes: () => [...service.peerIdsWithNoReconnectableLanes()],
        markReconnectable: simulation.markReconnectable
    };
}

class CountingClientCache extends LatestRepository<string, ClientInfo> {
    keysCalls = 0;

    override keys(): IterableIterator<string> {
        this.keysCalls += 1;
        return super.keys();
    }

    resetCounters(): void {
        this.keysCalls = 0;
    }
}

function createClientInfo(sessionId: string, isOnline: boolean): ClientInfo {
    return {
        clientId: sessionId,
        sessionId,
        isOnline
    };
}

function createGroupSnapshot(
    fixture: GroupSnapshotFixture
): GroupSnapshot {
    const applicationId = fixture.applicationId ?? 'app-1';
    const workspaceId = fixture.workspaceId ?? 'workspace-1';
    const ownerPrincipalId = fixture.memberSessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }

    const group = createTestGroup({
        applicationId,
        workspaceId,
        groupId: fixture.groupId,
        slug: fixture.groupId,
        displayName: fixture.groupId,
        activeMemberCount: fixture.memberSessionIds.length,
        ownerPrincipalId,
        snapshotVersion: fixture.membershipVersion,
        metadataVersion: 0,
        rosterVersion: fixture.membershipVersion,
        presenceVersion: fixture.membershipVersion,
        formationElectorate: [...fixture.memberSessionIds],
        acceptedLayoutIdentity: {
            groupRevision: fixture.membershipVersion,
            presenceRevision: fixture.membershipVersion,
            version: fixture.membershipVersion,
            state: 'active'
        },
        created: createAuditStamp(1, ownerPrincipalId),
        updated: createAuditStamp(fixture.membershipVersion, ownerPrincipalId)
    });
    return {
        causalRevision: {
            groupRevision: fixture.membershipVersion,
            presenceRevision: fixture.membershipVersion
        },
        group,
        members: fixture.memberSessionIds.map((sessionId) => createGroupMember(group, sessionId)),
        activeSessions: fixture.memberSessionIds.map((sessionId) => createGroupPresenceSession(group, sessionId)),
        memberCount: fixture.memberSessionIds.length,
        onlineMemberCount: fixture.memberSessionIds.length
    };
}

function createGroupMember(group: Group, sessionId: string): GroupMember {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        principalId: sessionId,
        role: sessionId === group.ownerPrincipalId ? 'owner' : 'member',
        status: 'active',
        joined: group.created,
        updated: group.updated,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function createGroupPresenceSession(group: Group, sessionId: string): GroupPresenceSession {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: group.rosterVersion,
        status: 'active',
        connectedAtEpochMs: group.rosterVersion,
        lastHeartbeatAtEpochMs: group.rosterVersion,
        expiresAtEpochMs: group.rosterVersion + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function createOverlayInfo(
    group: GroupSnapshot,
    nextHopSessionIds: readonly string[],
    overlayVersion = 1
): OverlayInfo {
    return {
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        sourceGroupStateCausalRevision: group.causalRevision,
        state: 'active',
        name: group.group.displayName,
        createdByClientId: group.group.ownerPrincipalId,
        createdAtEpochMs: group.group.created.atEpochMs,
        nextHopSessionIds,
        degreeLimit: Math.max(1, nextHopSessionIds.length),
        overlayVersion,
        updatedAtEpochMs: overlayVersion,
        provenance: 'server'
    };
}

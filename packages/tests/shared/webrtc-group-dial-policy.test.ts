import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { GROUP_LIFECYCLE_STATES, type GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
// dprint-ignore
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createTestGroup } from '../create-test-group.ts';

const LAYOUT_PRESENCE = [
    { planned: false, accepted: false },
    { planned: true, accepted: false },
    { planned: false, accepted: true },
    { planned: true, accepted: true }
] as const;

const DIAL_MATRIX = GROUP_LIFECYCLE_STATES.flatMap((lifecycleState) => LAYOUT_PRESENCE.map((presence) => ({ lifecycleState, ...presence })));

describe('WebRtcGroupManager lifecycle dial policy', () => {
    it.each(DIAL_MATRIX)(
        '$lifecycleState with planned=$planned accepted=$accepted selects the same outbound and inbound peers',
        async ({ lifecycleState, planned, accepted }) => {
            const runtime = dialRuntime(lifecycleState, { planned, accepted });

            await runtime.manager.acceptGroupUpdate(runtime.group);

            const expectedPeerIds = expectedDialPeerIds(lifecycleState, {
                planned,
                accepted
            });
            expect(runtime.outboundPeerIds()).toEqual(expectedPeerIds);
            for (const peerId of ['peer-planned', 'peer-accepted', 'peer-shared']) {
                expect(runtime.manager.isPeerDialAllowedByAnyGroup(peerId)).toBe(
                    expectedPeerIds.includes(peerId)
                );
            }
        }
    );

    it('does not treat a local bootstrap overlay as the frozen connecting layout', async () => {
        const runtime = dialRuntime('connecting', {
            planned: true,
            accepted: false,
            plannedProvenance: 'bootstrap'
        });

        await runtime.manager.acceptGroupUpdate(runtime.group);

        expect(runtime.outboundPeerIds()).toEqual([]);
        expect(runtime.manager.isPeerDialAllowedByAnyGroup('peer-planned')).toBe(false);
    });

    it('rejects a lagging planned-layout peer after the group is active', async () => {
        const runtime = dialRuntime('active', {
            planned: true,
            accepted: true
        });

        await runtime.manager.acceptGroupUpdate(runtime.group);

        expect(runtime.manager.isPeerDialAllowedByAnyGroup('peer-planned')).toBe(false);
        expect(runtime.manager.isPeerDialAllowedByAnyGroup('peer-accepted')).toBe(true);
    });
});

interface DialRuntimeOptions {
    readonly planned: boolean;
    readonly accepted: boolean;
    readonly plannedProvenance?: OverlayInfo['provenance'];
}

function dialRuntime(
    lifecycleState: GroupLifecycleState,
    options: DialRuntimeOptions
) {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new LatestRepository<string, ClientInfo>();
    const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const group = groupSnapshot(lifecycleState);
    const overlayId = toScopedOverlayId(group.group);
    const outboundPeers = new Set<string>();
    const ensurePeerConnectionStarted = vi.fn((peerId: string) => {
        outboundPeers.add(peerId);
        return Either.ofRight({ peerId } as never);
    });
    const manager = new WebRtcGroupManager(
        {
            input: { sessionId: 'self' },
            ensurePeerConnectionStarted,
            knownPeerIds: () => [...outboundPeers],
            peerIdsWithNoReconnectableLanes: () => [] as string[],
            disconnectPeer: (peerId: string) => outboundPeers.delete(peerId)
        } as never,
        {
            groupCache,
            clientCache,
            plannedOverlayCache,
            acceptedOverlayCache
        },
        { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
    );

    if (options.planned) {
        plannedOverlayCache.set(
            overlayId,
            overlay(
                group,
                ['peer-planned', 'peer-shared'],
                2,
                options.plannedProvenance ?? 'server'
            )
        );
    }
    if (options.accepted) {
        acceptedOverlayCache.set(
            overlayId,
            overlay(group, ['peer-accepted', 'peer-shared'], 1, 'server')
        );
    }

    return {
        group,
        manager,
        outboundPeerIds: () => [...outboundPeers].sort()
    };
}

function expectedDialPeerIds(
    lifecycleState: GroupLifecycleState,
    presence: Pick<DialRuntimeOptions, 'planned' | 'accepted'>
): readonly string[] {
    const planned = presence.planned ? ['peer-planned', 'peer-shared'] : [];
    const accepted = presence.accepted ? ['peer-accepted', 'peer-shared'] : [];
    switch (lifecycleState) {
        case 'connecting':
            return planned.sort();
        case 'active':
        case 'reconfiguring':
            return accepted.sort();
        case 'reconnecting':
            return [...new Set([...accepted, ...planned])].sort();
        case 'dormant':
        case 'forming':
        case 'planned':
            return [];
    }
}

function groupSnapshot(lifecycleState: GroupLifecycleState): GroupSnapshot {
    const group = createTestGroup({
        groupId: 'group-1',
        lifecycleState,
        snapshotVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1
    });
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group,
        members: [],
        activeSessions: [
            activeSession('self'),
            activeSession('peer-planned'),
            activeSession('peer-accepted'),
            activeSession('peer-shared')
        ],
        memberCount: 4,
        onlineMemberCount: 4
    };
}

function activeSession(sessionId: string): GroupSnapshot['activeSessions'][number] {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId: sessionId,
        sessionId,
        generationId: 'generation-1',
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function overlay(
    group: GroupSnapshot,
    nextHopSessionIds: readonly string[],
    overlayVersion: number,
    provenance: OverlayInfo['provenance']
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: overlayVersion,
            presenceRevision: overlayVersion
        },
        provenance,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: provenance === 'server' ? 'tree' : 'star',
        name: group.group.displayName,
        createdByClientId: provenance === 'server' ? 'server' : 'self',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...nextHopSessionIds],
        degreeLimit: 2,
        overlayVersion,
        updatedAtEpochMs: overlayVersion
    };
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureBrowserRtcPeerCreationPolicies } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { QRtcSignalingChannel, QRtcSignalingMsgType, QRtcSignalingType, type QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcConnectionFixture,
    type NativeRtcRuntime
} from '../../shared/native-rtc-connection-fixture.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface AdmissionScenario {
    readonly lifecycleState: GroupLifecycleState;
    readonly planned: boolean;
    readonly accepted: boolean;
    readonly plannedProvenance?: OverlayInfo['provenance'];
}

interface AdmissionRuntime {
    readonly group: GroupSnapshot;
    readonly manager: WebRtcGroupManager;
    readonly connection: NativeRtcConnectionFixture;
    readonly acceptedOverlays: LatestRepository<string, OverlayInfo>;
}

const STAGE_EXPECTATIONS = [
    { lifecycleState: 'dormant', permitsPlanned: false, permitsAccepted: false },
    { lifecycleState: 'forming', permitsPlanned: false, permitsAccepted: false },
    { lifecycleState: 'planned', permitsPlanned: false, permitsAccepted: false },
    { lifecycleState: 'connecting', permitsPlanned: true, permitsAccepted: false },
    { lifecycleState: 'active', permitsPlanned: false, permitsAccepted: true },
    { lifecycleState: 'reconfiguring', permitsPlanned: false, permitsAccepted: true },
    { lifecycleState: 'reconnecting', permitsPlanned: true, permitsAccepted: true }
] as const;

const CACHE_PRESENCE = [
    { planned: false, accepted: false },
    { planned: true, accepted: false },
    { planned: false, accepted: true },
    { planned: true, accepted: true }
] as const;

const DIAL_MATRIX = STAGE_EXPECTATIONS.flatMap((stage) =>
    CACHE_PRESENCE.map((presence) => ({
        ...stage,
        ...presence,
        expectedPeerIds: [
            ...new Set([
                ...(stage.permitsPlanned && presence.planned ? ['peer-planned', 'peer-shared'] : []),
                ...(stage.permitsAccepted && presence.accepted ? ['peer-accepted', 'peer-shared'] : [])
            ])
        ].sort()
    }))
);

let nativeRuntime: NativeRtcRuntime;
const connections = new Set<NativeRtcConnectionFixture>();

describe('browser RTC peer admission', () => {
    beforeEach(() => {
        nativeRuntime = installNativeRtcRuntime();
    });
    afterEach(() => {
        for (const connection of connections) {
            connection.dispose();
        }
        connections.clear();
        nativeRuntime.dispose();
    });

    it.each(DIAL_MATRIX)(
        '$lifecycleState with planned=$planned accepted=$accepted gates actual outbound dials and inbound offers',
        async (scenario) => {
            const outbound = await createAdmissionRuntime(scenario);
            const inbound = await createAdmissionRuntime(scenario);
            for (const peerId of ['peer-planned', 'peer-accepted', 'peer-shared', 'peer-unlisted']) {
                const allowed = scenario.expectedPeerIds.includes(peerId);
                const dial = outbound.connection.service.ensurePeerConnectionStarted(peerId);
                expect(dial.right?.peerId).toBe(allowed ? peerId : undefined);
                if (!allowed) {
                    expect(dial.left?.kind).toBe('dial-denied');
                }

                await inbound.connection.receive(offer(peerId));
                if (allowed) {
                    expect(inbound.connection.nativePeer(peerId).remoteDescription?.type).toBe('offer');
                }
            }

            expect(outbound.connection.createdPeerIds().slice().sort()).toEqual(scenario.expectedPeerIds);
            expect(inbound.connection.createdPeerIds().slice().sort()).toEqual(scenario.expectedPeerIds);
            expect(inbound.connection.service.knownPeerIds().slice().sort()).toEqual(scenario.expectedPeerIds);
        }
    );

    it('never admits a bootstrap overlay as the frozen connecting layout', async () => {
        const runtime = await createAdmissionRuntime({
            lifecycleState: 'connecting',
            planned: true,
            accepted: false,
            plannedProvenance: 'bootstrap'
        });

        expect(runtime.connection.service.ensurePeerConnectionStarted('peer-planned').left?.kind).toBe('dial-denied');
        await runtime.connection.receive(offer('peer-planned'));

        expect(runtime.connection.createdPeerIds()).toEqual([]);
        expect(nativeRuntime.createdConnections).toEqual([]);
    });

    it.each(['applicationId', 'workspaceId', 'groupId'] as const)(
        'does not use another %s layout when the current room layout is absent',
        async (field) => {
            const runtime = await createAdmissionRuntime({ lifecycleState: 'active', planned: false, accepted: true });
            const overlay = acceptedOverlay(runtime.group);
            const otherGroupRef = { ...overlay.groupRef, [field]: 'another-scope' };
            const otherOverlayId = toScopedOverlayId(otherGroupRef);
            runtime.acceptedOverlays.delete(overlay.overlayId);
            runtime.acceptedOverlays.set(otherOverlayId, {
                ...overlay,
                overlayId: otherOverlayId,
                groupRef: otherGroupRef
            });
            await runtime.manager.notifyOverlayTopologyChanged();

            expect(runtime.connection.service.ensurePeerConnectionStarted('peer-accepted').left?.kind).toBe('dial-denied');
            await runtime.connection.receive(offer('peer-accepted'));

            expect(runtime.connection.createdPeerIds()).toEqual([]);
        }
    );

    it('requires presence and selected layout in the same room for offers and every direct creation entrypoint', async () => {
        const runtime = await createAdmissionRuntime({ lifecycleState: 'active', planned: false, accepted: true });
        const currentGroup: GroupSnapshot = {
            ...runtime.group,
            group: { ...runtime.group.group, presenceVersion: 5 },
            causalRevision: { groupRevision: 3, presenceRevision: 5 },
            activeSessions: runtime.group.activeSessions.filter((session) => session.sessionId !== 'peer-accepted'),
            onlineMemberCount: 3
        };
        await runtime.manager.getOrCreate(currentGroup.group).acceptGroupUpdate(currentGroup);
        const otherGroup = createGroupSnapshotFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'other-room',
            sessionIds: ['self', 'peer-accepted']
        });
        runtime.acceptedOverlays.set(toScopedOverlayId(otherGroup.group), {
            ...acceptedOverlay(otherGroup),
            nextHopSessionIds: []
        });
        await runtime.manager.getOrCreate(otherGroup.group).acceptGroupUpdate(otherGroup);

        await runtime.connection.receive(offer('peer-accepted'));
        const direct = runtime.connection.service.ensurePeerConnectionStarted('peer-accepted');
        const signal = await runtime.connection.service.acceptPeerIfAbsent('peer-accepted', offer('peer-accepted'));
        const lane = await runtime.connection.service.ensurePeerLaneOpen('peer-accepted');

        expect(direct.left?.kind).toBe('dial-denied');
        expect(signal.left?.kind).toBe('dial-denied');
        expect(lane.status).toBe('connect-failed');
        expect(runtime.connection.createdPeerIds()).toEqual([]);
        expect(nativeRuntime.createdConnections).toEqual([]);
    });

    it('rejects a lagging planned offer after activation while retaining an established peer', async () => {
        const runtime = await createAdmissionRuntime({ lifecycleState: 'connecting', planned: true, accepted: true });
        expect(runtime.connection.service.ensurePeerConnectionStarted('peer-planned').right?.peerId).toBe('peer-planned');
        const established = runtime.connection.nativePeer('peer-planned');
        established.setConnected();
        for (const channel of established.channels) {
            await channel.open();
        }
        const active: GroupSnapshot = {
            ...runtime.group,
            group: { ...runtime.group.group, snapshotVersion: 4, lifecycleState: 'active' },
            causalRevision: { groupRevision: 4, presenceRevision: 4 }
        };
        await runtime.manager.getOrCreate(active.group).acceptGroupUpdate(active);

        expect(runtime.connection.service.ensurePeerConnectionStarted('peer-planned').right?.peerId).toBe('peer-planned');
        expect(runtime.connection.nativePeer('peer-planned')).toBe(established);
        runtime.connection.service.removePeerIfPresent('peer-planned');
        await runtime.connection.receive(offer('peer-planned'));
        await runtime.connection.receive(offer('peer-accepted'));

        expect(runtime.connection.service.readPeer('peer-planned')).toBeUndefined();
        expect(runtime.connection.nativePeer('peer-accepted').remoteDescription?.type).toBe('offer');
        expect(nativeRuntime.createdConnections).toHaveLength(2);
        expect(runtime.connection.service.knownPeerIds()).toEqual(['peer-accepted']);
    });
});

async function createAdmissionRuntime(scenario: AdmissionScenario): Promise<AdmissionRuntime> {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room',
        sessionIds: ['self', 'peer-planned', 'peer-accepted', 'peer-shared']
    });
    const group: GroupSnapshot = {
        ...snapshot,
        causalRevision: { groupRevision: 3, presenceRevision: 4 },
        group: {
            ...snapshot.group,
            snapshotVersion: 3,
            lifecycleState: scenario.lifecycleState,
            formationEpoch: 1,
            formationElectorate: snapshot.activeSessions.map((session) => session.sessionId),
            acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 4, version: 1, state: 'active' }
        }
    };
    const plannedOverlays = new LatestRepository<string, OverlayInfo>();
    const acceptedOverlays = new LatestRepository<string, OverlayInfo>();
    if (scenario.accepted) {
        acceptedOverlays.set(toScopedOverlayId(group.group), acceptedOverlay(group));
    }
    if (scenario.planned) {
        plannedOverlays.set(toScopedOverlayId(group.group), {
            ...acceptedOverlay(group),
            provenance: scenario.plannedProvenance ?? 'server',
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 4 },
            overlayVersion: 2,
            nextHopSessionIds: ['peer-planned', 'peer-shared']
        });
    }
    const connection = createNativeRtcConnectionFixture({
        sessionId: 'self',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc'
    }, nativeRuntime);
    connections.add(connection);
    const manager = new WebRtcGroupManager(connection.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        plannedOverlayCache: plannedOverlays,
        acceptedOverlayCache: acceptedOverlays
    });
    configureBrowserRtcPeerCreationPolicies(connection.service, manager);
    // Hydrate the real group owner without starting automatic reconciliation;
    // outbound and inbound tests must each attempt creation from an empty service.
    await manager.getOrCreate(group.group).acceptGroupUpdate(group);
    await connection.service.connectSignaler();
    return { group, manager, connection, acceptedOverlays };
}

function acceptedOverlay(group: GroupSnapshot): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: group.causalRevision.presenceRevision },
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        name: group.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: ['peer-accepted', 'peer-shared'],
        degreeLimit: 2,
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}

function offer(peerId: string): QRtcSignalingMessage {
    return {
        channel: QRtcSignalingChannel.RtcSignal,
        type: QRtcSignalingMsgType.Signal,
        fromId: peerId,
        toId: 'self',
        sessionId: peerId,
        token: 'fixture-token',
        signalType: QRtcSignalingType.Offer,
        payload: { description: { type: 'offer', sdp: `${peerId}-offer` }, candidate: null }
    };
}

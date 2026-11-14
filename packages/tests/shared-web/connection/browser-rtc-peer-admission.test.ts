import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON,
    configureBrowserRtcPeerCreationPolicies,
    createBrowserRtcHeldOfferReleases
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcSignalingChannel, QRtcSignalingMsgType, QRtcSignalingType, type QRtcSignalingMessage } from '@shared/webrtc/qrtc-signaling-contracts.ts';
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
    readonly plannedOverlays: LatestRepository<string, OverlayInfo>;
}

const STAGE_EXPECTATIONS = [
    { lifecycleState: 'dormant', permitsPlanned: false, permitsAccepted: false },
    { lifecycleState: 'forming', permitsPlanned: false, permitsAccepted: false },
    { lifecycleState: 'planned', permitsPlanned: false, permitsAccepted: false },
    { lifecycleState: 'connecting', permitsPlanned: true, permitsAccepted: false },
    { lifecycleState: 'active', permitsPlanned: true, permitsAccepted: true },
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
                expect(dial.right?.peer.peerId).toBe(allowed ? peerId : undefined);
                if (!allowed) {
                    expect(dial.left?.kind).toBe('dial-denied');
                }

                const inboundResult = await inbound.connection.receive(offer(peerId));
                expect(inboundResult).toBe(allowed ? undefined : 'retry');
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

    it('admits a planned-layout peer\'s offer while the room is active and holds that planned layout', async () => {
        const runtime = await createAdmissionRuntime({ lifecycleState: 'connecting', planned: true, accepted: true });
        const established = await activateWithEstablishedPlannedPeer(runtime);

        expect(runtime.connection.service.ensurePeerConnectionStarted('peer-planned').right?.peer.peerId).toBe('peer-planned');
        expect(runtime.connection.nativePeer('peer-planned')).toBe(established);
        runtime.connection.service.removePeerIfPresent('peer-planned');
        await runtime.connection.receive(offer('peer-planned'));
        await runtime.connection.receive(offer('peer-accepted'));

        expect(runtime.connection.nativePeer('peer-planned').remoteDescription?.type).toBe('offer');
        expect(runtime.connection.nativePeer('peer-accepted').remoteDescription?.type).toBe('offer');
        expect(runtime.connection.service.knownPeerIds().slice().sort()).toEqual(['peer-accepted', 'peer-planned']);
    });

    it.each([
        {
            planned: 'cleared',
            replan: (runtime: AdmissionRuntime) => runtime.plannedOverlays.delete(toScopedOverlayId(runtime.group.group))
        },
        {
            planned: 'replaced by a layout that does not name the peer',
            replan: (runtime: AdmissionRuntime) =>
                runtime.plannedOverlays.set(toScopedOverlayId(runtime.group.group), {
                    ...acceptedOverlay(runtime.group),
                    overlayVersion: 3,
                    nextHopSessionIds: ['peer-shared']
                })
        }
    ])(
        'refuses that peer\'s offer once the planned layout is $planned, while retaining an established peer',
        async (scenario) => {
            const runtime = await createAdmissionRuntime({ lifecycleState: 'connecting', planned: true, accepted: true });
            const established = await activateWithEstablishedPlannedPeer(runtime);
            scenario.replan(runtime);
            await runtime.manager.notifyOverlayTopologyChanged();

            expect(runtime.connection.service.ensurePeerConnectionStarted('peer-planned').right?.peer.peerId).toBe('peer-planned');
            expect(runtime.connection.nativePeer('peer-planned')).toBe(established);
            expect(established.connectionState).toBe('connected');
            runtime.connection.service.removePeerIfPresent('peer-planned');

            // The policy holds the offer for a retry because no layout this room dials names the peer.
            expect(runtime.manager.isPeerDialAllowedByAnyGroup('peer-planned')).toBe(false);
            expect(await runtime.connection.receive(offer('peer-planned'))).toBe('retry');
            expect(runtime.connection.service.readPeer('peer-planned')).toBeUndefined();
            expect(runtime.connection.service.knownPeerIds().slice().sort()).toEqual(['peer-accepted', 'peer-shared']);
        }
    );

    describe('at a full connection cap', () => {
        const accepted = ['a1', 'a2', 'a3', 'a4', 'a5'];
        const early = ['b1', 'b2', 'b3', 'b4', 'b5'];

        it('an accepted peer\'s offer at a full cap closes an early peer and is admitted at once', async () => {
            const runtime = await createFullCapRuntime({ accepted, planned: early });
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...early]);
            await hydrateSecondRoomWithoutReconcile(runtime, ['c1']);

            expect(await runtime.connection.receive(offer('c1'))).toBeUndefined();

            expect(runtime.connection.nativePeer('c1').remoteDescription?.type).toBe('offer');
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, 'b2', 'b3', 'b4', 'b5', 'c1']);
        });

        it('an accepted peer\'s offer at a full cap with no early peer is answered as before', async () => {
            const runtime = await createFullCapRuntime({ accepted, planned: accepted });
            // The replaced layout's edges stay retained for their grace and fill the cap with the new layout's.
            for (const overlays of [runtime.acceptedOverlays, runtime.plannedOverlays]) {
                overlays.set(toScopedOverlayId(runtime.group.group), {
                    ...acceptedOverlay(runtime.group),
                    overlayVersion: 3,
                    nextHopSessionIds: early
                });
            }
            await runtime.manager.notifyOverlayTopologyChanged();
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...early]);
            await hydrateSecondRoomWithoutReconcile(runtime, ['c1']);

            expect(await runtime.connection.receive(offer('c1'))).toBeUndefined();

            expect(runtime.connection.service.readPeer('c1')).toBeUndefined();
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...early]);
        });

        it('an early peer\'s offer at a full cap is held, never admitted by closing another peer', async () => {
            const runtime = await createFullCapRuntime({ accepted, planned: [...early, 'b6'] });
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...early]);

            expect(await runtime.connection.receive(offer('b6'))).toBe('retry');

            expect(runtime.connection.service.readPeer('b6')).toBeUndefined();
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...early]);
        });

        it('an early peer\'s offer held at a full cap is brought due by the reconcile pass after a peer closes', async () => {
            const runtime = await createFullCapRuntime({ accepted, planned: [...early, 'b6'] });
            expect(await runtime.connection.receive(offer('b6'))).toBe('retry');
            expect(runtime.connection.broughtDueSenderIds).toEqual([]);

            // The planned layout drops b1 and this browser closes it, so the pass frees its slot and does not redial it.
            runtime.plannedOverlays.set(toScopedOverlayId(runtime.group.group), {
                ...acceptedOverlay(runtime.group),
                overlayVersion: 3,
                nextHopSessionIds: ['b2', 'b3', 'b4', 'b5', 'b6']
            });
            runtime.connection.service.removePeerIfPresent('b1');
            await runtime.manager.notifyOverlayTopologyChanged();

            expect(runtime.connection.broughtDueSenderIds).toEqual(['b6']);
        });

        it('an offer from a peer of a layout this browser has not adopted yet is held, not dropped, while an early peer could make room', async () => {
            const runtime = await createFullCapRuntime({ accepted, planned: early });

            expect(await runtime.connection.receive(offer('c1'))).toBe('retry');

            expect(runtime.connection.service.readPeer('c1')).toBeUndefined();
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...early]);
        });

        it('the held offer is delivered when the layout is adopted, and one early peer closes for it', async () => {
            const runtime = await createFullCapRuntime({ accepted, planned: early });
            expect(await runtime.connection.receive(offer('c1'))).toBe('retry');
            await hydrateSecondRoomWithoutReconcile(runtime, ['c1']);

            await runtime.connection.service.writeHeldInboundSignalsDueNow(BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON);
            expect(runtime.connection.broughtDueSenderIds).toEqual(['c1']);
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...early]);

            // The transport delivers the released signal again.
            expect(await runtime.connection.receive(offer('c1'))).toBeUndefined();
            expect(runtime.connection.nativePeer('c1').remoteDescription?.type).toBe('offer');
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, 'b2', 'b3', 'b4', 'b5', 'c1']);
        });

        it('when this browser adopts the layout, its reconcile closes an early peer for each new entry and the released offers reuse those entries', async () => {
            const newPeers = ['c1', 'c2', 'c3', 'c4', 'c5'];
            const runtime = await createFullCapRuntime({ accepted, planned: early });
            for (const peerId of newPeers) {
                expect(await runtime.connection.receive(offer(peerId))).toBe('retry');
            }

            await adoptSecondRoomLayout(runtime, newPeers);
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...newPeers]);
            const entries = newPeers.map((peerId) => runtime.connection.nativePeer(peerId));

            await runtime.connection.service.writeHeldInboundSignalsDueNow(BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON);
            expect(runtime.connection.broughtDueSenderIds.slice().sort()).toEqual(newPeers);
            // The transport delivers each released signal again.
            for (const peerId of newPeers) {
                expect(await runtime.connection.receive(offer(peerId))).toBeUndefined();
            }

            expect(newPeers.map((peerId) => runtime.connection.nativePeer(peerId))).toEqual(entries);
            for (const peerId of newPeers) {
                expect(runtime.connection.nativePeer(peerId).receivedDescriptions).toContainEqual({ type: 'offer', sdp: `${peerId}-offer` });
            }
            expect(sortedKnownPeerIds(runtime)).toEqual([...accepted, ...newPeers]);
        });

        it('with no early peer known, such an offer at the cap is denied as before', async () => {
            const fullAccepted = [...accepted, ...early];
            const runtime = await createFullCapRuntime({ accepted: fullAccepted, planned: fullAccepted });

            expect(await runtime.connection.receive(offer('c1'))).toBeUndefined();

            expect(runtime.connection.service.readPeer('c1')).toBeUndefined();
            expect(sortedKnownPeerIds(runtime)).toEqual(fullAccepted);
        });
    });
});

const FULL_CAP_PRESENT_PEER_IDS = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

interface FullCapLayouts {
    readonly accepted: readonly string[];
    readonly planned: readonly string[];
}

async function createFullCapRuntime(layouts: FullCapLayouts): Promise<AdmissionRuntime> {
    const peerIds = [...new Set([...layouts.accepted, ...layouts.planned, ...FULL_CAP_PRESENT_PEER_IDS])];
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room',
        sessionIds: ['self', ...peerIds]
    });
    const group: GroupSnapshot = {
        ...snapshot,
        group: { ...snapshot.group, lifecycleState: 'active', formationEpoch: 1 }
    };
    const acceptedOverlays = new LatestRepository<string, OverlayInfo>();
    const plannedOverlays = new LatestRepository<string, OverlayInfo>();
    acceptedOverlays.set(toScopedOverlayId(group.group), { ...acceptedOverlay(group), nextHopSessionIds: layouts.accepted });
    plannedOverlays.set(toScopedOverlayId(group.group), {
        ...acceptedOverlay(group),
        overlayVersion: 2,
        nextHopSessionIds: layouts.planned
    });
    const connection = createNativeRtcConnectionFixture(
        {
            sessionId: 'self',
            token: 'fixture-token',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
            dataChannelName: 'test',
            rtcSignalingTopicId: 'rtc'
        },
        nativeRuntime,
        createPassThroughTransportFaultPort()
    );
    connections.add(connection);
    const manager = new WebRtcGroupManager(connection.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        plannedOverlayCache: plannedOverlays,
        acceptedOverlayCache: acceptedOverlays
    }, createBrowserRtcHeldOfferReleases(connection.service));
    configureBrowserRtcPeerCreationPolicies(connection.service, manager);
    await connection.service.connectSignaler();
    await manager.acceptGroupUpdate(group);
    return { group, manager, connection, acceptedOverlays, plannedOverlays };
}

// Hydrates the room's state without the reconcile the read-through would run, so its accepted peer's offer arrives
// before this browser dials that peer itself.
async function hydrateSecondRoomWithoutReconcile(runtime: AdmissionRuntime, acceptedPeerIds: readonly string[]): Promise<void> {
    const secondRoom = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'second-room',
        sessionIds: ['self', ...acceptedPeerIds]
    });
    const active: GroupSnapshot = {
        ...secondRoom,
        group: { ...secondRoom.group, lifecycleState: 'active', formationEpoch: 1 }
    };
    runtime.acceptedOverlays.set(toScopedOverlayId(active.group), {
        ...acceptedOverlay(active),
        nextHopSessionIds: acceptedPeerIds
    });
    await runtime.manager.getOrCreate(active.group).acceptGroupUpdate(active);
}

// Adopts the room's layout through the read-through, whose reconcile dials its accepted peers.
async function adoptSecondRoomLayout(runtime: AdmissionRuntime, acceptedPeerIds: readonly string[]): Promise<void> {
    const secondRoom = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'second-room',
        sessionIds: ['self', ...acceptedPeerIds]
    });
    const active: GroupSnapshot = {
        ...secondRoom,
        group: { ...secondRoom.group, lifecycleState: 'active', formationEpoch: 1 }
    };
    runtime.acceptedOverlays.set(toScopedOverlayId(active.group), {
        ...acceptedOverlay(active),
        nextHopSessionIds: acceptedPeerIds
    });
    await runtime.manager.acceptGroupUpdate(active);
}

function sortedKnownPeerIds(runtime: AdmissionRuntime): string[] {
    return runtime.connection.service.knownPeerIds().slice().sort();
}

async function activateWithEstablishedPlannedPeer(runtime: AdmissionRuntime) {
    expect(runtime.connection.service.ensurePeerConnectionStarted('peer-planned').right?.peer.peerId).toBe('peer-planned');
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
    return established;
}

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
    const connection = createNativeRtcConnectionFixture(
        {
            sessionId: 'self',
            token: 'fixture-token',

            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
            dataChannelName: 'test',
            rtcSignalingTopicId: 'rtc'
        },
        nativeRuntime,
        createPassThroughTransportFaultPort()
    );
    connections.add(connection);
    const manager = new WebRtcGroupManager(connection.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        plannedOverlayCache: plannedOverlays,
        acceptedOverlayCache: acceptedOverlays
    }, { onOverlayAdopted: async () => {}, onReconcilePassEnded: () => {} });
    configureBrowserRtcPeerCreationPolicies(connection.service, manager);
    // Hydrate the real group owner without starting automatic reconciliation;
    // outbound and inbound tests must each attempt creation from an empty service.
    await manager.getOrCreate(group.group).acceptGroupUpdate(group);
    await connection.service.connectSignaler();
    return { group, manager, connection, acceptedOverlays, plannedOverlays };
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
        nextHopsBySessionId: undefined,
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
        offerId: 'offer-1',
        payload: { description: { type: 'offer', sdp: `${peerId}-offer` }, candidate: null }
    };
}

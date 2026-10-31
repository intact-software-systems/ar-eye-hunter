import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { DeferredOverlayTopologies } from '@shared-web/browser/state-cache/deferred-overlay-topologies.ts';
import { adoptOverlayTopology } from '@shared-web/browser/state-cache/overlay-topology-message-dispatch.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot, validateAuthoritativeOverlayTopologySnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { computeRtcOutboundCarrierAvailability } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import { findGroupStateSnapshotByRef, setGroupStateSnapshot } from '@shared/repository/group-state-snapshots-repository.ts';
import { findAcceptedOverlayById } from '@shared/repository/overlays-repository.ts';
import { acceptGroupSnapshotUpdate, type GroupSnapshotRtcSyncPort } from '@shared/services/group-snapshot-rtc-sync.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const overlayId = toScopedOverlayId(roomRef);
const sessionIds = ['receiver', 'sender'];

/** The native connection effect is outside this cache/authority test; all cache adoption and send policy are real. */
const rtc: GroupSnapshotRtcSyncPort = {
    acceptGroupUpdate: async () => undefined,
    delete: async () => true,
    has: () => true,
    ensureAllGroupsConnected: async () => undefined
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    onTestFinished(() => {
        vi.useRealTimers();
    });
    configureTestCacheRepositories();
});

describe('RTC authority advancing past the layout received before reconnect', () => {
    it.each(['group-first', 'layout-first'] as const)('recovers through %s delivery while refusing the superseded layout', async (order) => {
        const deferredTopologies = new DeferredOverlayTopologies();
        const old = topology({ groupRevision: 35, presenceRevision: 25 }, 7);
        await acceptSnapshot(snapshot({ groupRevision: 36, presenceRevision: 25 }, old));
        await publish(old, deferredTopologies);
        expect(availability().kind).toBe('available');

        // The plan made during the sender's disconnect was delivered only to the receiver.
        // Its subsequent acceptance reaches both now-present sessions, as in #754.
        const whileAway = topology({ groupRevision: 36, presenceRevision: 25 }, 8, ['receiver']);
        await acceptSnapshot(snapshot({ groupRevision: 37, presenceRevision: 26 }, whileAway));
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
        expect(availability()).toMatchObject({ kind: 'unavailable', reason: 'RTC room has no cached overlay that is its exact accepted layout' });
        expect(await publish(old, deferredTopologies)).toMatchObject({ role: 'superseded', changed: false });

        const current = topology({ groupRevision: 37, presenceRevision: 26 }, 9);
        const authority = snapshot({ groupRevision: 38, presenceRevision: 26 }, current);
        if (order === 'group-first') {
            await acceptSnapshot(authority);
            expect(availability().kind).toBe('unavailable');
            await publish(current, deferredTopologies);
        }
        else {
            await publish(current, deferredTopologies);
            expect(availability().kind).toBe('unavailable');
            await acceptSnapshot(authority);
        }

        expect(availability().kind).toBe('available');
        expect(findAcceptedOverlayById(overlayId)?.overlayVersion).toBe(9);
        expect(await publish(whileAway, deferredTopologies)).toMatchObject({ role: 'superseded', changed: false });
        expect(availability().kind).toBe('available');
    });
});

async function acceptSnapshot(value: GroupSnapshot): Promise<void> {
    validateAuthoritativeGroupSnapshot(value, roomRef);
    setGroupStateSnapshot(value);
    await acceptGroupSnapshotUpdate(value, rtc, { localSessionId: 'sender', bootstrapDegree: 5 });
}

function publish(value: RallarOverlayTopologySnapshot, deferredTopologies: DeferredOverlayTopologies) {
    validateAuthoritativeOverlayTopologySnapshot(value, roomRef);
    return adoptOverlayTopology({
        topology: value,
        sessionId: 'sender',
        adoption: 'publication',
        deferredTopologies,
        webRtcGroupManager: { notifyOverlayTopologyChanged: async () => undefined }
    });
}

function availability() {
    return computeRtcOutboundCarrierAvailability({
        message: newALMulticastMessage('sender', { topicId: 'room.test', resourceId: 'message', contextId: 'room-test' }, roomRef, 'test', {}, {
            reliability: 'best-effort',
            ack: 'none'
        }),
        selfPeerId: 'sender',
        observation: {
            overlayId,
            room: findGroupStateSnapshotByRef(roomRef),
            overlay: findAcceptedOverlayById(overlayId),
            connectedPeerIds: ['receiver'],
            nowMs: Date.now()
        }
    });
}

function snapshot(causalRevision: GroupStateCausalRevision, accepted: RallarOverlayTopologySnapshot): GroupSnapshot {
    const base = createGroupSnapshotFixture({ ...roomRef, sessionIds });
    return {
        ...base,
        causalRevision,
        group: {
            ...base.group,
            snapshotVersion: causalRevision.groupRevision,
            presenceVersion: causalRevision.presenceRevision,
            acceptedLayoutIdentity: toGroupLayoutIdentity(accepted)
        }
    };
}

function topology(
    sourceGroupStateCausalRevision: GroupStateCausalRevision,
    version: number,
    activeSessionIds: string[] = sessionIds
): RallarOverlayTopologySnapshot {
    return {
        groupRef: roomRef,
        overlayId,
        sourceGroupStateCausalRevision,
        version,
        state: 'active',
        name: 'room',
        topology: 'star',
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(activeSessionIds.map((sessionId) => [
            sessionId,
            activeSessionIds.filter((peerId) => peerId !== sessionId)
        ])),
        degreeLimit: 5,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: version
    };
}

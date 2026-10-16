import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { toStoredRtcTopologySnapshotRow } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { computeGroupTopologyFromAuthority } from '@shared-server/rallar-system/topology/planning/compute-group-topology-from-authority.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { computeRtcTopologyWork } from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { readRtcTopologyWorkEnvelope, toRtcTopologyExecutionId } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeRtcTopologyHopEccentricity,
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    toRtcTopologyGroupWithDirector
} from '../../rtc-topology-test-fixtures.ts';

describe('RTC topology group-revision work', () => {
    it('replans an accepted layout around a director appointed after it', () => {
        const leaderless = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(30));
        const leaderlessAuthority = createPlanningAuthority(leaderless);
        const accepted = computeGroupTopologyFromAuthority(leaderlessAuthority, undefined, {
            intent: 'full-rebuild',
            origin: 'automatic'
        });
        if (accepted.action !== 'planned') {
            throw new Error('The leaderless layout fixture must plan');
        }
        const appointed = toAppointedRevision(leaderless, 'peer-12');
        const queued = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: appointed.group,
            expireAtEpochMs: 10_000,
            timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
            senderId: 'topology-service',
            origin: 'automatic',
            groupSnapshot: appointed,
            requestedAtEpochMs: 100,
            previousEntry: null
        }).entryWrite.entry;
        const entry = { ...queued, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
        const workEnvelope = readRtcTopologyWorkEnvelope(
            decodePersistedALMessage(entry.resource),
            AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
        );

        const computed = computeRtcTopologyWork({
            facts: {
                workEnvelope,
                workId: toRtcTopologyExecutionId(workEnvelope),
                attemptCount: 1,
                expireAtEpochMs: 10_000
            },
            read: {
                mutation: {
                    snapshot: {
                        value: accepted.snapshot,
                        entry: {
                            ...toStoredRtcTopologySnapshotRow(accepted.snapshot),
                            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                            updatedTimestamp: '2026-01-02T03:04:05.000Z',
                            revision: 1
                        }
                    },
                    publicationClaim: null
                },
                authority: createPlanningAuthority(appointed),
                promotion: { group: appointed.group, policy: { status: 'absent' } },
                storedInputFingerprint: computeAuthorityTopologyInputFingerprint(leaderlessAuthority)
            },
            publicationExpireAtTimestamp: null,
            entry,
            reservationFinish: {
                key: entry.key,
                expectedAttempts: 1,
                status: EntityStatus.COMPLETED,
                completedAt: new Date(2_000)
            },
            formationAutomationEnabled: false,
            serviceId: 'topology-service',
            publisherStreamId: undefined
        });

        const decision = computed.right?.accepted;
        expect(decision?.decision).toBe('accepted');
        if (decision?.decision !== 'accepted' || decision.mutationInput.candidate === null) {
            throw new Error('The appointment must produce an accepted layout');
        }
        const replanned = decision.mutationInput.candidate.nextHopsBySessionId;
        expect(computeRtcTopologyHopEccentricity(replanned, 'peer-12')).toBeLessThan(
            computeRtcTopologyHopEccentricity(accepted.snapshot.nextHopsBySessionId, 'peer-12')
        );
    });
});

function createPlanningAuthority(group: GroupSnapshot): GroupTopologyPlanningAuthority {
    return {
        group,
        config: resolveGroupTopologyConfig({ serverOptions: { topologyKind: 'tree' } }),
        kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
        rttReportingDegreeLimit: 5,
        rttMeasurements: [],
        replanning: 'auto',
        nowEpochMs: 2_000
    };
}

function toAppointedRevision(group: GroupSnapshot, directorSessionId: string): GroupSnapshot {
    const appointed = toRtcTopologyGroupWithDirector(group, directorSessionId);
    return {
        ...appointed,
        causalRevision: { ...group.causalRevision, groupRevision: group.causalRevision.groupRevision + 1 },
        group: {
            ...appointed.group,
            snapshotVersion: group.group.snapshotVersion + 1,
            metadataVersion: group.group.metadataVersion + 1
        }
    };
}

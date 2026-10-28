import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import {
    toRtcRttMutationReceiptId,
    toRtcRttTopologyOutboxId
} from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { toStoredRtcTopologySnapshotRow } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { computeGroupTopologyFromAuthority } from '@shared-server/rallar-system/topology/planning/compute-group-topology-from-authority.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { computeRtcTopologyWorkWrite } from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work-write.ts';
import {
    computeRtcTopologyWork,
    type ComputeRtcTopologyWorkInput
} from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { readRtcTopologyWorkEnvelope, toRtcTopologyExecutionId } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { recordRtcTopologyWorkTiming } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-timing.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeRtcTopologyHopEccentricity,
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement,
    toRtcTopologyGroupWithDirector
} from '../../rtc-topology-test-fixtures.ts';

const ACCEPTED_AT_EPOCH_MS = 2_000;
const MINIMUM_LAYOUT_AGE_MS = 15_000;

describe('RTC topology group-revision work', () => {
    it('replans an accepted layout around a director appointed after it', () => {
        const leaderless = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(30));
        const leaderlessAuthority = createPlanningAuthority(leaderless, ACCEPTED_AT_EPOCH_MS);
        const accepted = computeGroupTopologyFromAuthority(leaderlessAuthority, undefined, {
            intent: 'full-rebuild',
            origin: 'automatic'
        });
        if (accepted.action !== 'planned') {
            throw new Error('The leaderless layout fixture must plan');
        }
        const appointed = toAppointedRevision(leaderless, 'peer-12');
        const queued = computeCoalescedRtcTopologyGroupRevisionWork({
            traceId: 'trace-compute-rtc-topology-work',
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
                traceId: 'trace-compute-rtc-topology-work',
                workEnvelope,
                workId: toRtcTopologyExecutionId(workEnvelope, decodePersistedALMessage(entry.resource).id.ts),
                attemptCount: 1,
                derivedExpireAtEpochMs: 10_000
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
                authority: createPlanningAuthority(appointed, ACCEPTED_AT_EPOCH_MS),
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

describe('RTC topology RTT-refresh work', () => {
    it('holds an RTT-only replan while the accepted layout is younger than the minimum age', () => {
        const held = computeRttRefreshDecision({
            accepted: acceptPathLayout(createRtcTopologyMemberIds(6)),
            current: toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6))),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
        });

        expect(held.decision).toBe('held-young-layout');
        if (held.decision !== 'held-young-layout') {
            throw new Error('The young layout must hold the RTT-only replan');
        }
        expect(held.rttReplanPromotion).toEqual({
            decision: 'hold',
            reason: 'layout-younger-than-minimum-age',
            layoutAgeMs: 500
        });
        expect(held.criterionPetition.planned.nextHopsBySessionId).toEqual(toPathNextHops(createRtcTopologyMemberIds(6)));
    });

    it('promotes the same RTT-only replan once the accepted layout reaches the minimum age', () => {
        const promoted = computeRttRefreshDecision({
            accepted: acceptPathLayout(createRtcTopologyMemberIds(6)),
            current: toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6))),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + MINIMUM_LAYOUT_AGE_MS
        });

        expect(promoted.decision).toBe('accepted');
        if (promoted.decision !== 'accepted' || promoted.mutationInput.candidate === null) {
            throw new Error('The aged layout must promote the RTT replan');
        }
        expect(promoted.rttReplanPromotion).toEqual({
            decision: 'promote',
            reason: 'layout-at-minimum-age',
            layoutAgeMs: MINIMUM_LAYOUT_AGE_MS
        });
        expect(promoted.mutationInput.candidate.nextHopsBySessionId).not.toEqual(
            toPathNextHops(createRtcTopologyMemberIds(6))
        );
    });

    it('promotes a join at once while the accepted layout is still young', () => {
        const promoted = computeRttRefreshDecision({
            accepted: acceptPathLayout(createRtcTopologyMemberIds(6)),
            current: toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(7))),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
        });

        expect(promoted.decision).toBe('accepted');
        if (promoted.decision !== 'accepted' || promoted.mutationInput.candidate === null) {
            throw new Error('The join must promote a layout at once');
        }
        expect(promoted.rttReplanPromotion).toEqual({
            decision: 'promote',
            reason: 'topology-inputs-changed',
            layoutAgeMs: 500
        });
        expect(promoted.mutationInput.candidate.activeSessionIds).toContain('peer-7');
    });

    it('promotes at once when presence advanced past the accepted layout', () => {
        const members = createRtcTopologyMemberIds(6);
        const current = toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', members));
        const promoted = computeRttRefreshDecision({
            accepted: acceptPathLayout(members),
            current: {
                ...current,
                causalRevision: { ...current.causalRevision, presenceRevision: 1 },
                group: { ...current.group, presenceVersion: 1 }
            },
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
        });

        expect(promoted.decision).toBe('accepted');
        expect(promoted.decision === 'accepted' ? promoted.rttReplanPromotion : null).toEqual({
            decision: 'promote',
            reason: 'presence-advanced',
            layoutAgeMs: 500
        });
    });

    it('promotes an RTT-only replan at once, without an age, when no layout is stored', () => {
        const workInput = toRttRefreshWorkInput({
            accepted: acceptPathLayout(createRtcTopologyMemberIds(6)),
            current: toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6))),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
        });
        const computed = computeRtcTopologyWork({
            ...workInput,
            read: { ...workInput.read, mutation: { ...workInput.read.mutation, snapshot: null }, storedInputFingerprint: null }
        });

        const promoted = computed.right?.accepted;
        expect(promoted?.decision).toBe('accepted');
        expect(promoted?.decision === 'accepted' ? promoted.rttReplanPromotion : null).toEqual({
            decision: 'promote',
            reason: 'no-active-layout'
        });
    });

    it('writes a held replan as the frozen path writes: the stored layout targeted, no layout, fingerprint or delivery', () => {
        const workInput = toRttRefreshWorkInput({
            accepted: acceptPathLayout(createRtcTopologyMemberIds(6)),
            current: toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6))),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
        });

        const computed = computeRtcTopologyWork(workInput).right;

        if (computed?.accepted.decision !== 'held-young-layout' || computed.write.kind !== 'transaction') {
            throw new Error('The young layout must hold the RTT-only replan in one transaction');
        }
        expect(computed.write.transaction).toMatchObject({ mutation: null, fingerprint: null, delivery: null });
        expect(computed.write.transaction.promotionWrite).not.toBeNull();
        const held = computed.accepted;
        expect(computed.write).toEqual(computeRtcTopologyWorkWrite({
            traceId: 'trace-compute-rtc-topology-work',
            accepted: {
                decision: 'skipped-frozen',
                work: held.work,
                group: held.group,
                promotionRead: held.promotionRead,
                criterionPetition: held.criterionPetition
            },
            entry: workInput.entry,
            sourceWorkId: workInput.facts.workId,
            derivedExpireAtEpochMs: workInput.facts.derivedExpireAtEpochMs,
            reservationFinish: workInput.reservationFinish,
            formationAutomationEnabled: workInput.formationAutomationEnabled,
            serviceId: workInput.serviceId,
            publisherStreamId: workInput.publisherStreamId
        }));
    });

    it('names the held decision and its reason on the recompute timing line only while timing is on', () => {
        const held = computeRttRefreshDecision({
            accepted: acceptPathLayout(createRtcTopologyMemberIds(6)),
            current: toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6))),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
        });
        const events: RallarTimingEvent[] = [];

        recordRtcTopologyWorkTiming({ timing: undefined, serviceId: 'topology-service', accepted: held, computeDurationMs: 3 });
        recordRtcTopologyWorkTiming({
            timing: (event) => events.push(event),
            serviceId: 'topology-service',
            accepted: held,
            computeDurationMs: 3
        });

        expect(events).toEqual([expect.objectContaining({
            component: 'rtc-topology-work',
            operation: 'recompute',
            groupId: 'group-1',
            durationMs: 3,
            details: expect.objectContaining({
                workKind: 'rtt-refresh',
                decision: 'held-young-layout',
                reason: 'layout-younger-than-minimum-age',
                layoutAgeMs: 500,
                groupRevision: 3
            })
        })]);
    });
});

interface AcceptedPathLayout {
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly inputFingerprint: string;
}

/** A valid accepted tree the planner would not produce itself, so an RTT replan of it always changes the layout. */
function acceptPathLayout(memberSessionIds: readonly string[]): AcceptedPathLayout {
    const group = createRtcTopologyGroupSnapshot('group-1', memberSessionIds);
    const authority = createPlanningAuthority(group, ACCEPTED_AT_EPOCH_MS);
    const planned = computeGroupTopologyFromAuthority(authority, undefined, { intent: 'full-rebuild', origin: 'automatic' });
    if (planned.action !== 'planned') {
        throw new Error('The accepted layout fixture must plan');
    }
    return {
        snapshot: { ...planned.snapshot, nextHopsBySessionId: toPathNextHops(memberSessionIds) },
        inputFingerprint: computeAuthorityTopologyInputFingerprint(authority)
    };
}

function toPathNextHops(memberSessionIds: readonly string[]): Record<string, readonly string[]> {
    return Object.fromEntries(memberSessionIds.map((sessionId, index) => [
        sessionId,
        [memberSessionIds[index - 1], memberSessionIds[index + 1]].filter((peer) => peer !== undefined).sort()
    ]));
}

interface ComputeRttRefreshDecisionInput {
    readonly accepted: AcceptedPathLayout;
    readonly current: GroupSnapshot;
    readonly nowEpochMs: number;
}

function computeRttRefreshDecision(input: ComputeRttRefreshDecisionInput) {
    const computed = computeRtcTopologyWork(toRttRefreshWorkInput(input));
    if (computed.right === undefined) {
        throw new Error('The RTT refresh must compute a decision');
    }
    return computed.right.accepted;
}

function toRttRefreshWorkInput(input: ComputeRttRefreshDecisionInput): ComputeRtcTopologyWorkInput {
    const entry = toReservedRttRefreshEntry(input.current);
    const workEnvelope = readRtcTopologyWorkEnvelope(
        decodePersistedALMessage(entry.resource),
        AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
    );
    return {
        facts: {
            traceId: 'trace-compute-rtc-topology-work',
            workEnvelope,
            workId: toRtcTopologyExecutionId(workEnvelope, decodePersistedALMessage(entry.resource).id.ts),
            attemptCount: 1,
            derivedExpireAtEpochMs: 4_102_444_800_000
        },
        read: {
            mutation: {
                snapshot: {
                    value: input.accepted.snapshot,
                    entry: {
                        ...toStoredRtcTopologySnapshotRow(input.accepted.snapshot),
                        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                        updatedTimestamp: '2026-01-02T03:04:05.000Z',
                        revision: 1
                    }
                },
                publicationClaim: null
            },
            authority: createPlanningAuthority(input.current, input.nowEpochMs),
            promotion: { group: input.current.group, policy: { status: 'absent' } },
            storedInputFingerprint: input.accepted.inputFingerprint
        },
        publicationExpireAtTimestamp: null,
        entry,
        reservationFinish: { key: entry.key, expectedAttempts: 1, status: EntityStatus.COMPLETED, completedAt: new Date(input.nowEpochMs) },
        formationAutomationEnabled: false,
        serviceId: 'topology-service',
        publisherStreamId: undefined
    };
}

function toReservedRttRefreshEntry(group: GroupSnapshot): ResourceEntry {
    const rtt = createRtcTopologyRttMeasurement({ sessionIdFrom: 'peer-1', sessionIdTo: 'peer-2', rttMs: 40, version: 1 });
    const receiptId = toRtcRttMutationReceiptId(rtt);
    const resourceId = toRtcRttTopologyOutboxId(receiptId, group.group, `sha256:${'a'.repeat(64)}`);
    const queued = computeRtcTopologyOutboxInsert({
        traceId: 'trace-compute-rtc-topology-work',
        commandId: resourceId,
        aggregateRef: group.group,
        acceptedCausalRevision: group.causalRevision,
        groupSnapshot: group,
        effectKind: 'rtc-topology-recompute',
        createdAtEpochMs: 1_000,
        expireAtEpochMs: 4_102_444_800_000,
        senderId: 'topology-service',
        resourceId,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true,
        payloadKind: 'rtt-refresh',
        rtt,
        refinementObservationId: receiptId
    }).entry;
    return { ...queued, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
}

/** A lifecycle bump moves the group revision without touching the topology inputs, as activation does after a layout. */
function toLaterGroupRevision(group: GroupSnapshot): GroupSnapshot {
    return {
        ...group,
        causalRevision: { ...group.causalRevision, groupRevision: group.causalRevision.groupRevision + 2 },
        group: { ...group.group, snapshotVersion: group.group.snapshotVersion + 2 }
    };
}

function createPlanningAuthority(group: GroupSnapshot, nowEpochMs: number): GroupTopologyPlanningAuthority {
    return {
        group,
        config: resolveGroupTopologyConfig({ serverOptions: { topologyKind: 'tree' } }),
        kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
        rttReportingDegreeLimit: 5,
        rttMeasurements: [],
        rttReplanMinimumLayoutAgeMs: MINIMUM_LAYOUT_AGE_MS,
        replanning: 'auto',
        nowEpochMs
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

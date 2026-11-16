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
import { computeTopologyLayoutDelta } from '@shared-server/rallar-system/topology/planning/plan-record/compute-topology-layout-delta.ts';
import type { TopologyWorkOrigin } from '@shared-server/rallar-system/topology/planning/resolve-topology-plan-action.ts';
import {
    DEFAULT_MESH_EXIT_WIDTH,
    DEFAULT_TREE_EXIT_WIDTH
} from '@shared-server/rallar-system/topology/planning/topology-kind-hysteresis.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import {
    computeRtcTopologyWorkWrite,
    type AcceptedRtcTopologyWork
} from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work-write.ts';
import {
    computeRtcTopologyWork,
    validateRtcTopologyWork,
    type ComputeRtcTopologyWorkInput
} from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { readRtcTopologyWorkEnvelope, toRtcTopologyExecutionId } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { recordRtcTopologyWorkTiming } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-timing.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    computeRtcTopologyFixtureLeave,
    computeRtcTopologyFixturePlan,
    computeRtcTopologyFixtureRebuild,
    createRtcTopologyFixtureGroup,
    RTC_TOPOLOGY_TREE_OPTIONS,
    type RtcTopologyFixtureReplanned
} from '../../planning/rtc-topology-planning-fixtures.ts';
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
        const accepted = acceptPlannedLayout(leaderless);
        const appointed = toAppointedRevision(leaderless, 'peer-12');

        const computed = computeRtcTopologyWork(
            toGroupRevisionWorkInput({ stored: accepted, current: appointed, nowEpochMs: ACCEPTED_AT_EPOCH_MS })
        );

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

describe('RTC topology work publication record', () => {
    it('a first plan\'s publication records that it replaced nothing', () => {
        const group = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6));

        const publication = computePublishedWork(
            toGroupRevisionWorkInput({ stored: null, current: group, nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500 })
        );

        expect(publication.plan).toMatchObject({
            plannedAtEpochMs: ACCEPTED_AT_EPOCH_MS + 500,
            replaced: null,
            causes: ['join'],
            delta: { joinedSessionCount: 6, leftSessionCount: 0 }
        });
    });

    it('a membership plan\'s publication records the replaced layout, its age, join and leave, and the delta', () => {
        const stored = acceptPlannedLayout(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6)));
        const current = toLaterGroupRevision(
            createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(7).slice(1))
        );

        const publication = computePublishedWork(
            toGroupRevisionWorkInput({ stored, current, nowEpochMs: ACCEPTED_AT_EPOCH_MS + 4_000 })
        );

        expect(publication.plan).toMatchObject({
            plannedAtEpochMs: ACCEPTED_AT_EPOCH_MS + 4_000,
            replaced: { layout: toGroupLayoutIdentity(stored.snapshot), ageMs: 4_000 },
            causes: ['join', 'leave'],
            delta: computeTopologyLayoutDelta(stored.snapshot, publication.snapshot)
        });
        expect(publication.plan?.delta).toMatchObject({ joinedSessionCount: 1, leftSessionCount: 1 });
    });

    it('an RTT refresh\'s publication records rtt as its cause', () => {
        const workInput = toRttRefreshWorkInput({
            accepted: acceptPathLayout(createRtcTopologyMemberIds(6)),
            current: toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6))),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + MINIMUM_LAYOUT_AGE_MS
        });

        const publication = computePublishedWork(workInput);

        expect(publication.plan?.causes).toEqual(['rtt']);
        expect(publication.plan?.replaced?.ageMs).toBe(MINIMUM_LAYOUT_AGE_MS);
    });

    it('a removal\'s publication records no plan', () => {
        const stored = acceptPlannedLayout(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6)));
        // The room expires with a revision that also lets a member go, so the input fingerprint changes and the work runs.
        const later = toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(5)));
        const expired = { ...later, group: { ...later.group, expiresAtEpochMs: ACCEPTED_AT_EPOCH_MS + 1 } };

        const publication = computePublishedWork(
            toGroupRevisionWorkInput({ stored, current: expired, nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500 })
        );

        expect(publication.snapshot.state).toBe('removed');
        expect(publication.plan).toBeNull();
    });

    it('a plan that only advances presence coverage is published with an empty delta and no cause', () => {
        const group = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6));
        const stored = acceptPlannedLayout(group);
        const present = {
            ...group,
            causalRevision: { ...group.causalRevision, presenceRevision: 1 },
            group: { ...group.group, presenceVersion: 1 }
        };

        const publication = computePublishedWork(
            toGroupRevisionWorkInput({ stored, current: present, nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500 })
        );

        expect(publication.plan?.causes).toEqual([]);
        expect(publication.plan?.delta).toEqual({
            joinedSessionCount: 0,
            leftSessionCount: 0,
            changedSessionCount: 0,
            reroutedSessionCount: 0,
            acceptingSessionCount: 0,
            maxJoinerEdgesPerSession: 0
        });
    });

    it('validateRtcTopologyWork accepts the computed work and refuses one whose accepted record differs', () => {
        const stored = acceptPlannedLayout(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6)));
        const current = toLaterGroupRevision(createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(7)));
        const workInput = toPublishingWorkInput(
            toGroupRevisionWorkInput({ stored, current, nowEpochMs: ACCEPTED_AT_EPOCH_MS + 4_000 })
        );
        const computed = computeRtcTopologyWork(workInput);
        const accepted = computed.right?.accepted;
        if (
            computed.right === undefined || accepted?.decision !== 'accepted' || accepted.publication === null ||
            accepted.publication.plan === null
        ) {
            throw new Error('The join must publish a planned layout');
        }
        // Validation compares the whole recomputed projection, so altering the record is enough to refuse.
        const alteredRecord: typeof computed = Either.ofRight({
            ...computed.right,
            accepted: {
                ...accepted,
                publication: { ...accepted.publication, plan: { ...accepted.publication.plan, causes: ['rtt'] } }
            }
        });

        expect(validateRtcTopologyWork(workInput, computed)).toEqual([]);
        expect(validateRtcTopologyWork(workInput, alteredRecord)).not.toEqual([]);
    });
});

describe('RTC topology work plan change', () => {
    it('a join on a tree is recorded with the publication as an attach', () => {
        const accepted = computeFixtureReplanWork(toTreeJoinReplan());

        expect(accepted.publication?.plan?.change).toEqual({ kind: 'attach' });
    });

    it('a leaf\'s leave is recorded as a repair', () => {
        const left = computeRtcTopologyFixtureLeave({ ...TREE_OF_EIGHT, leaver: (nextHopCount) => nextHopCount === 1 });

        const accepted = computeFixtureReplanWork(left);

        expect(accepted.publication?.plan?.change).toEqual({ kind: 'repair' });
    });

    it('a relay\'s leave is recorded as a repair whose delta reroutes nobody', () => {
        const left = computeRtcTopologyFixtureLeave({ ...TREE_OF_EIGHT, leaver: (nextHopCount) => nextHopCount > 1 });

        const accepted = computeFixtureReplanWork(left);

        expect(accepted.publication?.plan?.change).toEqual({ kind: 'repair' });
        expect(accepted.publication?.plan?.delta.reroutedSessionCount).toBe(0);
    });

    it('a change of kind is recorded as a reshape for kind-change', () => {
        const accepted = computeFixtureReplanWork(computeRtcTopologyFixtureRebuild('kind-change'));

        expect(accepted.publication?.plan?.change).toEqual({ kind: 'reshape', reason: 'kind-change' });
    });

    it('an RTT refresh that rebuilds is recorded as a reshape for refinement', () => {
        const replanned = computeRtcTopologyFixtureRebuild('refinement');

        const accepted = computeFixtureReplanWork(replanned);

        expect(accepted.work.kind).toBe('rtt-refresh');
        expect(accepted.publication?.plan?.change).toEqual({ kind: 'reshape', reason: 'refinement' });
    });

    it('a plan that only advances presence coverage records no change', () => {
        const group = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6));
        const present = {
            ...group,
            causalRevision: { ...group.causalRevision, presenceRevision: 1 },
            group: { ...group.group, presenceVersion: 1 }
        };
        const workInput = toGroupRevisionWorkInput({
            stored: acceptPlannedLayout(group),
            current: present,
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
        });

        const accepted = computeAcceptedWork(toPublishingWorkInput(workInput));

        expect(accepted.publication?.plan?.change).toBeNull();
    });

    it('the recompute line names the plan\'s kind and a reshape\'s reason', () => {
        const events: RallarTimingEvent[] = [];
        const record = (accepted: AcceptedRtcTopologyWork) =>
            recordRtcTopologyWorkTiming({
                timing: (event) => events.push(event),
                serviceId: 'topology-service',
                accepted,
                computeDurationMs: 3,
                traceId: 'trace-plan-change-recompute'
            });

        record(computeFixtureReplanWork(computeRtcTopologyFixtureRebuild('refinement')));
        record(computeFixtureReplanWork(toTreeJoinReplan()));

        expect(events.map((event) => event.details)).toEqual([
            expect.objectContaining({ planChange: 'reshape', reshapeReason: 'refinement' }),
            expect.objectContaining({ planChange: 'attach', reshapeReason: undefined })
        ]);
    });

    it('a director appointed after the layout re-roots it: caused by leader-change, a reshape for leader-rooting', () => {
        const leaderless = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(30));
        const workInput = toGroupRevisionWorkInput({
            stored: acceptPlannedLayout(leaderless),
            current: toAppointedRevision(leaderless, 'peer-12'),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS
        });

        const publication = computePublishedWork(workInput);

        expect(publication.plan?.causes).toContain('leader-change');
        expect(publication.plan?.change).toEqual({ kind: 'reshape', reason: 'leader-rooting' });
    });

    it('an RTT refresh that re-roots the tree at a newly appointed director is caused by leader-change and rtt, and is a leader-rooting reshape', () => {
        const members = createRtcTopologyMemberIds(30);
        const leaderless = createRtcTopologyGroupSnapshot('group-1', members);
        const workInput = toRttRefreshWorkInput({
            accepted: acceptPlannedLayout(leaderless),
            current: toAppointedRevision(leaderless, 'peer-12'),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + MINIMUM_LAYOUT_AGE_MS
        });
        // Measured RTTs send the refresh down the refinement path, whose evolution of the kept tree asks for the re-root.
        const measuredWorkInput = toPublishingWorkInput({
            ...workInput,
            read: {
                ...workInput.read,
                authority: { ...workInput.read.authority, rttMeasurements: toNearIdenticalRttMeasurements(members) }
            }
        });

        const accepted = computeAcceptedWork(measuredWorkInput);

        expect(accepted.work.kind).toBe('rtt-refresh');
        expect(accepted.publication?.plan?.causes).toEqual(['leader-change', 'rtt']);
        expect(accepted.publication?.plan?.change).toEqual({ kind: 'reshape', reason: 'leader-rooting' });
    });

    it('a commanded group revision is not change-gated, so it is caused by config', () => {
        const group = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6));
        const workInput = toWorkInput({
            entry: toReservedGroupRevisionEntry(toLaterGroupRevision(group), 'commanded'),
            stored: acceptPlannedLayout(group),
            authority: createPlanningAuthority(toLaterGroupRevision(group), ACCEPTED_AT_EPOCH_MS + 500)
        });

        const publication = computePublishedWork(workInput);

        expect(publication.plan?.causes).toContain('config');
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

    it('plans no edge change for an aged leaderless tree when near-identical RTTs promise no worthwhile gain', () => {
        const members = createRtcTopologyMemberIds(50);
        const group = createRtcTopologyGroupSnapshot('group-1', members);
        const accepted = acceptPlannedLayout(group);
        const rttMeasurements = toNearIdenticalRttMeasurements(members);
        const workInput = toRttRefreshWorkInput({
            accepted,
            current: toLaterGroupRevision(group),
            nowEpochMs: ACCEPTED_AT_EPOCH_MS + MINIMUM_LAYOUT_AGE_MS
        });

        const replanned = computeRtcTopologyWork({
            ...workInput,
            read: { ...workInput.read, authority: { ...workInput.read.authority, rttMeasurements } }
        }).right?.accepted;

        expect(replanned?.decision).toBe('skipped-unchanged');
        if (replanned?.decision !== 'skipped-unchanged') {
            throw new Error('The kept tree must leave the accepted layout unchanged');
        }
        expect(replanned.criterionPetition?.planned.nextHopsBySessionId).toEqual(accepted.snapshot.nextHopsBySessionId);
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

        recordRtcTopologyWorkTiming({
            timing: undefined,
            serviceId: 'topology-service',
            accepted: held,
            computeDurationMs: 3,
            traceId: 'trace-held-recompute'
        });
        recordRtcTopologyWorkTiming({
            timing: (event) => events.push(event),
            serviceId: 'topology-service',
            accepted: held,
            computeDurationMs: 3,
            traceId: 'trace-held-recompute'
        });

        expect(events).toEqual([expect.objectContaining({
            component: 'rtc-topology-work',
            operation: 'recompute',
            groupId: 'group-1',
            traceId: 'trace-held-recompute',
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

interface AcceptedLayout {
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly inputFingerprint: string;
}

/** A valid accepted tree the planner would not produce itself, so an RTT replan of it always changes the layout. */
function acceptPathLayout(memberSessionIds: readonly string[]): AcceptedLayout {
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

/** The tree the planner forms for a leaderless room before any RTT is reported. */
function acceptPlannedLayout(group: GroupSnapshot): AcceptedLayout {
    const authority = createPlanningAuthority(group, ACCEPTED_AT_EPOCH_MS);
    const planned = computeGroupTopologyFromAuthority(authority, undefined, { intent: 'full-rebuild', origin: 'automatic' });
    if (planned.action !== 'planned') {
        throw new Error('The accepted layout fixture must plan');
    }
    return { snapshot: planned.snapshot, inputFingerprint: computeAuthorityTopologyInputFingerprint(authority) };
}

function toPathNextHops(memberSessionIds: readonly string[]): Record<string, readonly string[]> {
    return Object.fromEntries(memberSessionIds.map((sessionId, index) => [
        sessionId,
        [memberSessionIds[index - 1], memberSessionIds[index + 1]].filter((peer) => peer !== undefined).sort()
    ]));
}

const PUBLICATION_EXPIRE_AT_EPOCH_MS = 4_102_444_800_000;

interface ToGroupRevisionWorkInput {
    readonly stored: AcceptedLayout | null;
    readonly current: GroupSnapshot;
    readonly nowEpochMs: number;
}

/** Automatic, coalesced membership work: the change-gated kind every join and leave queues. */
function toGroupRevisionWorkInput(input: ToGroupRevisionWorkInput): ComputeRtcTopologyWorkInput {
    return toWorkInput({
        entry: toReservedGroupRevisionEntry(input.current, 'automatic'),
        stored: input.stored,
        authority: createPlanningAuthority(input.current, input.nowEpochMs)
    });
}

function toReservedGroupRevisionEntry(current: GroupSnapshot, origin: TopologyWorkOrigin): ResourceEntry {
    const queued = computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-compute-rtc-topology-work',
        aggregateRef: current.group,
        expireAtEpochMs: PUBLICATION_EXPIRE_AT_EPOCH_MS,
        timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'topology-service',
        origin,
        groupSnapshot: current,
        requestedAtEpochMs: 100,
        previousEntry: null
    }).entryWrite.entry;
    return { ...queued, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
}

/** The same work as published: with a publication expiry, the work writes a publication row. */
function toPublishingWorkInput(input: ComputeRtcTopologyWorkInput): ComputeRtcTopologyWorkInput {
    return { ...input, publicationExpireAtTimestamp: PUBLICATION_EXPIRE_AT_EPOCH_MS };
}

function computePublishedWork(input: ComputeRtcTopologyWorkInput): RtcTopologyPublication {
    const { publication } = computeAcceptedWork(toPublishingWorkInput(input));
    if (publication === null) {
        throw new Error('The work must publish a planned layout');
    }
    return publication;
}

type AcceptedWork = Extract<AcceptedRtcTopologyWork, { decision: 'accepted'; }>;

function computeAcceptedWork(input: ComputeRtcTopologyWorkInput): AcceptedWork {
    const accepted = computeRtcTopologyWork(input).right?.accepted;
    if (accepted?.decision !== 'accepted') {
        throw new Error('The work must accept a planned layout');
    }
    return accepted;
}

const TREE_OF_EIGHT = { options: RTC_TOPOLOGY_TREE_OPTIONS, memberCount: 8, joinerCount: 0 };

type FixtureReplan = Pick<RtcTopologyFixtureReplanned, 'previous' | 'replanInput'>;

/** A seventh member joins the six-member tree the planner formed. */
function toTreeJoinReplan(): FixtureReplan {
    const previous = computeRtcTopologyFixturePlan({
        options: RTC_TOPOLOGY_TREE_OPTIONS,
        group: createRtcTopologyFixtureGroup(6),
        previous: undefined
    }).snapshot;
    return { previous, replanInput: { options: RTC_TOPOLOGY_TREE_OPTIONS, group: createRtcTopologyFixtureGroup(7), previous } };
}

/** The published work that replans a planning fixture's room over its formed layout, under the fixture's options. */
function toFixtureReplanWorkInput(replan: FixtureReplan): ComputeRtcTopologyWorkInput {
    const { options, group, rttMeasurements, planningIntent } = replan.replanInput;
    const current = toLaterGroupRevision(group);
    const authority: GroupTopologyPlanningAuthority = {
        ...createPlanningAuthority(current, ACCEPTED_AT_EPOCH_MS + MINIMUM_LAYOUT_AGE_MS),
        config: resolveGroupTopologyConfig({ serverOptions: options }),
        kindHysteresisWidths: { meshExitWidth: DEFAULT_MESH_EXIT_WIDTH, treeExitWidth: DEFAULT_TREE_EXIT_WIDTH },
        rttReportingDegreeLimit: options.rttReportingDegreeLimit ?? 5,
        rttMeasurements: rttMeasurements ?? []
    };
    return toPublishingWorkInput(toWorkInput({
        entry: planningIntent === 'full-rebuild' ? toReservedRttRefreshEntry(current) : toReservedGroupRevisionEntry(current, 'automatic'),
        stored: { snapshot: replan.previous, inputFingerprint: 'sha256:formed-layout' },
        authority
    }));
}

/** Also pins that the work plans what the fixture's planner planned, so the kind is the fixture's. */
function computeFixtureReplanWork(replan: FixtureReplan & Partial<Pick<RtcTopologyFixtureReplanned, 'planned'>>): AcceptedWork {
    const accepted = computeAcceptedWork(toFixtureReplanWorkInput(replan));
    if (replan.planned !== undefined) {
        expect(accepted.mutationInput.candidate?.nextHopsBySessionId).toEqual(replan.planned.snapshot.nextHopsBySessionId);
    }
    return accepted;
}

interface ToWorkInput {
    readonly entry: ResourceEntry;
    readonly stored: AcceptedLayout | null;
    readonly authority: GroupTopologyPlanningAuthority;
}

function toWorkInput(input: ToWorkInput): ComputeRtcTopologyWorkInput {
    const { entry, stored, authority } = input;
    const message = decodePersistedALMessage(entry.resource);
    const workEnvelope = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
    return {
        facts: {
            traceId: 'trace-compute-rtc-topology-work',
            workEnvelope,
            workId: toRtcTopologyExecutionId(workEnvelope, message.id.ts),
            attemptCount: 1,
            derivedExpireAtEpochMs: PUBLICATION_EXPIRE_AT_EPOCH_MS
        },
        read: {
            mutation: {
                snapshot: stored === null ? null : {
                    value: stored.snapshot,
                    entry: {
                        ...toStoredRtcTopologySnapshotRow(stored.snapshot),
                        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                        updatedTimestamp: '2026-01-02T03:04:05.000Z',
                        revision: 1
                    }
                },
                publicationClaim: null
            },
            authority,
            promotion: { group: authority.group.group, policy: { status: 'absent' } },
            storedInputFingerprint: stored?.inputFingerprint ?? null
        },
        publicationExpireAtTimestamp: null,
        entry,
        reservationFinish: {
            key: entry.key,
            expectedAttempts: 1,
            status: EntityStatus.COMPLETED,
            completedAt: new Date(authority.nowEpochMs)
        },
        formationAutomationEnabled: false,
        serviceId: 'topology-service',
        publisherStreamId: undefined
    };
}

interface ComputeRttRefreshDecisionInput {
    readonly accepted: AcceptedLayout;
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
    return toWorkInput({
        entry: toReservedRttRefreshEntry(input.current),
        stored: input.accepted,
        authority: createPlanningAuthority(input.current, input.nowEpochMs)
    });
}

/** Every pair measured, at near-identical RTTs between 2 and 3 ms. */
function toNearIdenticalRttMeasurements(members: readonly string[]): RttMeasurementInfo[] {
    return members.flatMap((sessionIdFrom, fromIndex) =>
        members.slice(fromIndex + 1).map((sessionIdTo, toIndex) =>
            createRtcTopologyRttMeasurement({
                sessionIdFrom,
                sessionIdTo,
                rttMs: 2 + ((fromIndex * 37 + toIndex * 11) % 10) / 10,
                version: fromIndex * members.length + toIndex + 1
            })
        )
    );
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

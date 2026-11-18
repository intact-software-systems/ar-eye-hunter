import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import {
    toRtcRttMutationReceiptId,
    toRtcRttTopologyOutboxId
} from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import {
    computeRtcTopologyOutboxInsert,
    computeRtcTopologyReshapeDueEntry
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import {
    decodeStoredTopologyReshapeGate,
    type StoredTopologyReshapeGate
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-reshape-gate-store.ts';
import { toStoredRtcTopologySnapshotRow } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { computeGroupTopologyFromAuthority } from '@shared-server/rallar-system/topology/planning/compute-group-topology-from-authority.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { computeTopologyLayoutDelta } from '@shared-server/rallar-system/topology/planning/plan-record/compute-topology-layout-delta.ts';
import { toTopologyReshapeBounds } from '@shared-server/rallar-system/topology/planning/reshape-gate/to-topology-reshape-bounds.ts';
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
import type { RtcTopologyPublicationTransactionWrite } from '@shared-server/rallar-system/topology/replay/work/write-rtc-topology-publication-transaction.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type {
    HeldTopologyReshapeReason,
    TopologyReshapeGateState
} from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { BackoffGateState } from '@shared/resilience/backoff-gate.ts';
import { Either } from '@shared/resilience/Either.ts';

import { EMPTY_TOPOLOGY_LAYOUT_DELTA } from '../../../../../shared/api/topology-plan/empty-topology-layout-delta.ts';
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
        expect(publication.plan?.delta).toEqual(EMPTY_TOPOLOGY_LAYOUT_DELTA);
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

    it('the recompute line names the reshape reasons a plan held, and omits them for a plan that held none', () => {
        const events: RallarTimingEvent[] = [];
        const record = (accepted: AcceptedRtcTopologyWork) =>
            recordRtcTopologyWorkTiming({
                timing: (event) => events.push(event),
                serviceId: 'topology-service',
                accepted,
                computeDurationMs: 3,
                traceId: 'trace-held-reshape-recompute'
            });
        const accepted = computeFixtureReplanWork(toTreeJoinReplan());
        const { publication } = accepted;
        if (publication?.plan == null) {
            throw new Error('Expected the tree join to publish a plan record');
        }
        const { plan } = publication;
        const holding = (heldReshapeReasons: readonly HeldTopologyReshapeReason[]): AcceptedWork => ({
            ...accepted,
            publication: { ...publication, plan: { ...plan, heldReshapeReasons } }
        });

        record(holding(['kind-change']));
        record(holding(['kind-change', 'leader-rooting']));
        record(accepted);

        expect(events.map((event) => event.details?.heldReshapeReasons)).toEqual([
            'kind-change',
            'kind-change,leader-rooting',
            undefined
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

describe('RTC topology work reshape gate', () => {
    const NOW_EPOCH_MS = ACCEPTED_AT_EPOCH_MS + MINIMUM_LAYOUT_AGE_MS;

    it('a join that would change the kind while the gate is closed is attached and the reshape is recorded as wanted', () => {
        const workInput = withReshapeGate(
            toFixtureReplanWorkInput(computeRtcTopologyFixtureRebuild('kind-change')),
            toClosedReshapeGate(NOW_EPOCH_MS)
        );

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.decision).toBe('accepted');
        const plan = accepted.decision === 'accepted' ? accepted.publication?.plan : null;
        expect(plan?.change).toEqual({ kind: 'attach' });
        expect(plan?.heldReshapeReasons).toEqual(['kind-change']);
        expect(transaction.reshapeGate?.expectedRevision).toBe(3);
        expect(readWrittenReshapeGateState(transaction)).toEqual({
            gate: { lastPassAtEpochMs: NOW_EPOCH_MS - 5_000, consecutiveHeldPasses: 0, heldAtEpochMs: NOW_EPOCH_MS },
            wantedReasons: ['kind-change']
        });
        expect(transaction.reshapeDueWrite?.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(NOW_EPOCH_MS + 10_000);
    });

    it('the same join with the gate open reshapes and starts a period', () => {
        const workInput = withReshapeGate(
            toFixtureReplanWorkInput(computeRtcTopologyFixtureRebuild('kind-change')),
            toOpenReshapeGate(NOW_EPOCH_MS)
        );

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.decision === 'accepted' ? accepted.publication?.plan?.change : null)
            .toEqual({ kind: 'reshape', reason: 'kind-change' });
        expect(readWrittenReshapeGateState(transaction)).toEqual({
            gate: { lastPassAtEpochMs: NOW_EPOCH_MS, consecutiveHeldPasses: 0, heldAtEpochMs: null },
            wantedReasons: []
        });
    });

    it('a leader appointed in a quiet room with the gate closed writes the hold and no layout', () => {
        const leaderless = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(30));
        const workInput = withReshapeGate(
            toGroupRevisionWorkInput({
                stored: acceptPlannedLayout(leaderless),
                current: toAppointedRevision(leaderless, 'peer-12'),
                nowEpochMs: NOW_EPOCH_MS
            }),
            toClosedReshapeGate(NOW_EPOCH_MS)
        );

        const computed = computeRtcTopologyWork(workInput).right;

        expect(computed?.accepted.decision).toBe('skipped-unchanged');
        if (computed?.write.kind !== 'transaction') {
            throw new Error('The held re-root must write the gate in one transaction');
        }
        expect(computed.write.transaction.mutation).toBeNull();
        expect(readWrittenReshapeGateState(computed.write.transaction)?.wantedReasons).toEqual(['leader-rooting']);
    });

    it('a commanded reconfigure passes a closed gate and starts a period with the count unchanged', () => {
        const workInput = withReshapeGate(
            toFixtureReplanWorkInput(
                computeRtcTopologyFixtureRebuild('kind-change'),
                (current) => toReservedGroupRevisionEntry(current, 'commanded')
            ),
            toStoredReshapeGate({ lastPassAtEpochMs: NOW_EPOCH_MS - 5_000, consecutiveHeldPasses: 2, heldAtEpochMs: null }, 3)
        );

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.decision === 'accepted' ? accepted.reshape : null).toBe('allowed');
        expect(accepted.decision === 'accepted' ? accepted.publication?.plan?.change : null)
            .toEqual({ kind: 'reshape', reason: 'kind-change' });
        expect(readWrittenReshapeGateState(transaction)).toEqual({
            gate: { lastPassAtEpochMs: NOW_EPOCH_MS, consecutiveHeldPasses: 2, heldAtEpochMs: null },
            wantedReasons: []
        });
    });

    it('automatic changes merged into a commanded row pass with it', () => {
        const workInput = withReshapeGate(
            toFixtureReplanWorkInput(computeRtcTopologyFixtureRebuild('kind-change'), toMergedCommandedGroupRevisionEntry),
            toClosedReshapeGate(NOW_EPOCH_MS)
        );

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.work.kind === 'group-revision' ? accepted.work.origin : null).toBe('commanded');
        expect(accepted.decision === 'accepted' ? accepted.publication?.plan?.change : null)
            .toEqual({ kind: 'reshape', reason: 'kind-change' });
        expect(readWrittenReshapeGateState(transaction)?.gate.lastPassAtEpochMs).toBe(NOW_EPOCH_MS);
    });

    it('a first layout resets a used gate', () => {
        const group = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6));
        const workInput = withReshapeGate(
            toGroupRevisionWorkInput({ stored: null, current: group, nowEpochMs: NOW_EPOCH_MS }),
            toStoredReshapeGate(
                { lastPassAtEpochMs: NOW_EPOCH_MS - 5_000, consecutiveHeldPasses: 1, heldAtEpochMs: NOW_EPOCH_MS - 1_000 },
                2,
                ['kind-change']
            )
        );

        const { transaction } = computeGatedWork(workInput);

        expect(transaction.reshapeGate?.expectedRevision).toBe(2);
        expect(readWrittenReshapeGateState(transaction)).toEqual({
            gate: { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: null },
            wantedReasons: []
        });
    });

    it('a room with no stored gate and no reshape writes nothing for the gate', () => {
        const { accepted, transaction } = computeGatedWork(withReshapeGate(toFixtureReplanWorkInput(toTreeJoinReplan()), null));

        expect(accepted.decision === 'accepted' ? accepted.reshapeGate : null).toEqual({ decision: 'unchanged' });
        expect(transaction.reshapeGate).toBeNull();
    });

    it('an RTT refresh while the gate is closed keeps the stored layout', () => {
        const replan = computeRtcTopologyFixtureRebuild('refinement');
        const workInput = withReshapeGate(toFixtureReplanWorkInput(replan), toClosedReshapeGate(NOW_EPOCH_MS));

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.decision).toBe('skipped-unchanged');
        expect(transaction).toMatchObject({ mutation: null, delivery: null, reshapeGate: null });
        expect(accepted.decision === 'skipped-unchanged' ? accepted.criterionPetition?.planned.nextHopsBySessionId : null)
            .toEqual(replan.previous.nextHopsBySessionId);
    });

    it('a published refinement starts a period', () => {
        const workInput = withReshapeGate(
            toFixtureReplanWorkInput(computeRtcTopologyFixtureRebuild('refinement')),
            toOpenReshapeGate(NOW_EPOCH_MS)
        );

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.decision === 'accepted' ? accepted.publication?.plan?.change : null)
            .toEqual({ kind: 'reshape', reason: 'refinement' });
        expect(readWrittenReshapeGateState(transaction)?.gate).toEqual({
            lastPassAtEpochMs: NOW_EPOCH_MS,
            consecutiveHeldPasses: 0,
            heldAtEpochMs: null
        });
    });

    it('validation refuses a computed work whose gate state was altered', () => {
        const workInput = withReshapeGate(
            toFixtureReplanWorkInput(computeRtcTopologyFixtureRebuild('kind-change')),
            toClosedReshapeGate(NOW_EPOCH_MS)
        );
        const computed = computeRtcTopologyWork(workInput);
        const accepted = computed.right?.accepted;
        if (computed.right === undefined || accepted?.decision !== 'accepted' || accepted.reshapeGate.decision !== 'write') {
            throw new Error('The held join must write the gate');
        }
        const altered: typeof computed = Either.ofRight({
            ...computed.right,
            accepted: {
                ...accepted,
                reshapeGate: { ...accepted.reshapeGate, state: { ...accepted.reshapeGate.state, wantedReasons: [] } }
            }
        });

        expect(validateRtcTopologyWork(workInput, computed)).toEqual([]);
        expect(validateRtcTopologyWork(workInput, altered)).not.toEqual([]);
    });

    it('the recompute line names whether the reshape was held or allowed', () => {
        const events: RallarTimingEvent[] = [];
        const record = (input: ComputeRtcTopologyWorkInput) =>
            recordRtcTopologyWorkTiming({
                timing: (event) => events.push(event),
                serviceId: 'topology-service',
                accepted: computeGatedWork(input).accepted,
                computeDurationMs: 3,
                traceId: 'trace-reshape-gate-recompute'
            });
        const joined = toFixtureReplanWorkInput(computeRtcTopologyFixtureRebuild('kind-change'));

        record(withReshapeGate(joined, toClosedReshapeGate(NOW_EPOCH_MS)));
        record(withReshapeGate(joined, toOpenReshapeGate(NOW_EPOCH_MS)));

        expect(events.map((event) => event.details?.reshape)).toEqual(['held', 'allowed']);
    });
});

describe('RTC topology reshape-due work', () => {
    const PERIOD_STARTED_AT_EPOCH_MS = 100_000;
    const GATE_OPENS_AT_EPOCH_MS = 115_000;
    const HELD_GATE: BackoffGateState = {
        lastPassAtEpochMs: PERIOD_STARTED_AT_EPOCH_MS,
        consecutiveHeldPasses: 0,
        heldAtEpochMs: 103_000
    };

    it('a reshape-due row at an open gate reshapes the room and doubles the interval', () => {
        const replan = computeRtcTopologyFixtureRebuild('kind-change');
        const held = computeGatedWork(withReshapeGate(toFixtureReplanWorkInput(replan), toClosedReshapeGate(17_000)));
        const attached = held.accepted.decision === 'accepted' ? held.accepted.mutationInput.candidate : null;
        if (attached === null) {
            throw new Error('The held join must attach the joiner');
        }
        const workInput = withReshapeGate(
            atNow(
                toFixtureReplanWorkInput(
                    { previous: attached, replanInput: replan.replanInput },
                    (current) => toReservedReshapeDueEntry(current, PERIOD_STARTED_AT_EPOCH_MS)
                ),
                GATE_OPENS_AT_EPOCH_MS
            ),
            toStoredReshapeGate(HELD_GATE, 3, ['kind-change'])
        );

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.decision === 'accepted' ? accepted.publication?.plan?.change : null)
            .toEqual({ kind: 'reshape', reason: 'kind-change' });
        expect(readWrittenReshapeGateState(transaction)).toEqual({
            gate: { lastPassAtEpochMs: GATE_OPENS_AT_EPOCH_MS, consecutiveHeldPasses: 1, heldAtEpochMs: null },
            wantedReasons: []
        });
        expect(transaction.reshapeDueWrite).toBeNull();
    });

    it('a reshape-due row whose want has gone clears the want and publishes nothing', () => {
        const leaderless = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(30));
        const current = toLaterGroupRevision(leaderless);
        const workInput = withReshapeGate(
            toWorkInput({
                entry: toReservedReshapeDueEntry(current, PERIOD_STARTED_AT_EPOCH_MS),
                stored: acceptPlannedLayout(leaderless),
                authority: createPlanningAuthority(current, GATE_OPENS_AT_EPOCH_MS)
            }),
            toStoredReshapeGate(HELD_GATE, 3, ['kind-change'])
        );

        const { accepted, transaction } = computeGatedWork(workInput);

        expect(accepted.decision).toBe('skipped-unchanged');
        expect(transaction).toMatchObject({ mutation: null, delivery: null, reshapeDueWrite: null });
        expect(readWrittenReshapeGateState(transaction)).toEqual({ gate: HELD_GATE, wantedReasons: [] });
    });

    it('a reshape-due row of an earlier period completes without planning', () => {
        const group = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6));
        const workInput = withReshapeGate(
            toWorkInput({
                entry: toReservedReshapeDueEntry(group, PERIOD_STARTED_AT_EPOCH_MS),
                stored: acceptPlannedLayout(group),
                authority: createPlanningAuthority(group, GATE_OPENS_AT_EPOCH_MS)
            }),
            toStoredReshapeGate({ lastPassAtEpochMs: 110_000, consecutiveHeldPasses: 1, heldAtEpochMs: null }, 4)
        );

        const computed = computeRtcTopologyWork(workInput).right;

        expect(computed?.accepted.decision).toBe('skipped-reshape-settled');
        expect(computed?.write).toEqual({ kind: 'completion-only', reservationFinish: workInput.reservationFinish });
        expect(validateRtcTopologyWork(workInput, computeRtcTopologyWork(workInput))).toEqual([]);
    });

    it('a reshape-due row in a quiet room is not skipped by an unchanged input fingerprint', () => {
        const leaderless = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(30));
        const appointed = toAppointedRevision(leaderless, 'peer-12');
        const authority = createPlanningAuthority(appointed, GATE_OPENS_AT_EPOCH_MS);
        const stored = { ...acceptPlannedLayout(leaderless), inputFingerprint: computeAuthorityTopologyInputFingerprint(authority) };
        const reshapeGate = toStoredReshapeGate(HELD_GATE, 3, ['leader-rooting']);
        const toQuietWork = (entry: ResourceEntry) => withReshapeGate(toWorkInput({ entry, stored, authority }), reshapeGate);

        const membership = computeRtcTopologyWork(toQuietWork(toReservedGroupRevisionEntry(appointed, 'automatic'))).right;
        const reshapeDue = computeAcceptedWork(
            toPublishingWorkInput(toQuietWork(toReservedReshapeDueEntry(appointed, PERIOD_STARTED_AT_EPOCH_MS)))
        );

        expect(membership?.accepted.decision).toBe('skipped-fingerprint');
        expect(reshapeDue.publication?.plan?.change).toEqual({ kind: 'reshape', reason: 'leader-rooting' });
        expect(reshapeDue.publication?.plan?.causes).toEqual(['leader-change']);
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
            finishedRetentionMs: workInput.facts.finishedRetentionMs,
            reservationFinish: workInput.reservationFinish,
            formationAutomationEnabled: workInput.formationAutomationEnabled,
            serviceId: workInput.serviceId,
            publisherStreamId: workInput.publisherStreamId,
            storedReshapeGateRevision: null
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
    const planned = computeGroupTopologyFromAuthority(authority, undefined, {
        intent: 'full-rebuild',
        origin: 'automatic',
        reshape: { reshape: 'allowed', wantedReasons: [] }
    });
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
    const planned = computeGroupTopologyFromAuthority(authority, undefined, {
        intent: 'full-rebuild',
        origin: 'automatic',
        reshape: { reshape: 'allowed', wantedReasons: [] }
    });
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

/**
 * The published work that replans a planning fixture's room over its formed layout, under the fixture's options. The
 * work row is the RTT refresh or automatic membership row the fixture's intent names, unless the caller reserves another.
 */
function toFixtureReplanWorkInput(
    replan: FixtureReplan,
    toEntry: ((current: GroupSnapshot) => ResourceEntry) | null = null
): ComputeRtcTopologyWorkInput {
    const { options, group, rttMeasurements, planningIntent } = replan.replanInput;
    const current = toLaterGroupRevision(group);
    const defaultEntry = planningIntent === 'full-rebuild'
        ? toReservedRttRefreshEntry(current)
        : toReservedGroupRevisionEntry(current, 'automatic');
    const authority: GroupTopologyPlanningAuthority = {
        ...createPlanningAuthority(current, ACCEPTED_AT_EPOCH_MS + MINIMUM_LAYOUT_AGE_MS),
        config: resolveGroupTopologyConfig({ serverOptions: options }),
        kindHysteresisWidths: { meshExitWidth: DEFAULT_MESH_EXIT_WIDTH, treeExitWidth: DEFAULT_TREE_EXIT_WIDTH },
        rttReportingDegreeLimit: options.rttReportingDegreeLimit ?? 5,
        rttMeasurements: rttMeasurements ?? []
    };
    return toPublishingWorkInput(toWorkInput({
        entry: toEntry === null ? defaultEntry : toEntry(current),
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
            derivedExpireAtEpochMs: PUBLICATION_EXPIRE_AT_EPOCH_MS,
            finishedRetentionMs: 3_600_000
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
            storedInputFingerprint: stored?.inputFingerprint ?? null,
            reshapeGate: null
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
        reshapeBounds: toTopologyReshapeBounds({ status: 'absent' }),
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

/** An automatic membership change merged into a queued commanded row, which stays commanded. */
function toMergedCommandedGroupRevisionEntry(current: GroupSnapshot): ResourceEntry {
    const commanded = computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-compute-rtc-topology-work',
        aggregateRef: current.group,
        expireAtEpochMs: PUBLICATION_EXPIRE_AT_EPOCH_MS,
        timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'topology-service',
        origin: 'commanded',
        groupSnapshot: current,
        requestedAtEpochMs: 100,
        previousEntry: null
    }).entryWrite.entry;
    const reserved = toReservedGroupRevisionEntry(current, 'automatic');
    const merged = computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-compute-rtc-topology-work',
        aggregateRef: current.group,
        expireAtEpochMs: PUBLICATION_EXPIRE_AT_EPOCH_MS,
        timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'topology-service',
        origin: 'automatic',
        groupSnapshot: current,
        requestedAtEpochMs: 200,
        previousEntry: commanded
    }).entryWrite.entry;
    return { ...merged, status: reserved.status, dequeueAudit: reserved.dequeueAudit };
}

/** A held reshape's wake-up row, queued for the period that started at the given instant, as a server reserves it. */
function toReservedReshapeDueEntry(current: GroupSnapshot, periodStartedAtEpochMs: number): ResourceEntry {
    const queued = computeRtcTopologyReshapeDueEntry({
        groupRef: current.group,
        periodStartedAtEpochMs,
        notBeforeEpochMs: periodStartedAtEpochMs + 15_000,
        requestedAtEpochMs: periodStartedAtEpochMs + 3_000,
        expireAtEpochMs: PUBLICATION_EXPIRE_AT_EPOCH_MS,
        senderId: 'topology-service',
        traceId: 'trace-compute-rtc-topology-work'
    });
    return { ...queued, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
}

function atNow(input: ComputeRtcTopologyWorkInput, nowEpochMs: number): ComputeRtcTopologyWorkInput {
    return { ...input, read: { ...input.read, authority: { ...input.read.authority, nowEpochMs } } };
}

function withReshapeGate(
    input: ComputeRtcTopologyWorkInput,
    reshapeGate: StoredTopologyReshapeGate | null
): ComputeRtcTopologyWorkInput {
    return { ...input, read: { ...input.read, reshapeGate } };
}

function toStoredReshapeGate(
    gate: BackoffGateState,
    revision: number,
    wantedReasons: readonly HeldTopologyReshapeReason[] = []
): StoredTopologyReshapeGate {
    return { state: { gate, wantedReasons }, revision };
}

/** The room was reshaped 5 s ago and nothing has been held since: the 15 s gate is closed. */
function toClosedReshapeGate(nowEpochMs: number): StoredTopologyReshapeGate {
    return toStoredReshapeGate({ lastPassAtEpochMs: nowEpochMs - 5_000, consecutiveHeldPasses: 0, heldAtEpochMs: null }, 3);
}

/** The room was reshaped 20 s ago: the 15 s gate is open. */
function toOpenReshapeGate(nowEpochMs: number): StoredTopologyReshapeGate {
    return toStoredReshapeGate({ lastPassAtEpochMs: nowEpochMs - 20_000, consecutiveHeldPasses: 0, heldAtEpochMs: null }, 3);
}

interface GatedWork {
    readonly accepted: AcceptedRtcTopologyWork;
    readonly transaction: RtcTopologyPublicationTransactionWrite;
}

function computeGatedWork(input: ComputeRtcTopologyWorkInput): GatedWork {
    const computed = computeRtcTopologyWork(input).right;
    if (computed?.write.kind !== 'transaction') {
        throw new Error('The work must commit one transaction');
    }
    return { accepted: computed.accepted, transaction: computed.write.transaction };
}

function readWrittenReshapeGateState(transaction: RtcTopologyPublicationTransactionWrite): TopologyReshapeGateState | null {
    const { reshapeGate } = transaction;
    return reshapeGate === null ? null : decodeStoredTopologyReshapeGate(reshapeGate.key, reshapeGate.value);
}

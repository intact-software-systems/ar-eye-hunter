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
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { computeRtcTopologyWorkWrite } from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work-write.ts';
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
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

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

    it('validateRtcTopologyWork accepts the computed work and refuses one whose record was altered', () => {
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
        const altered: typeof computed = Either.ofRight({
            ...computed.right,
            accepted: {
                ...accepted,
                publication: { ...accepted.publication, plan: { ...accepted.publication.plan, causes: ['rtt'] } }
            }
        });

        expect(validateRtcTopologyWork(workInput, computed)).toEqual([]);
        expect(validateRtcTopologyWork(workInput, altered)).not.toEqual([]);
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
        const rttMeasurements = members.flatMap((sessionIdFrom, fromIndex) =>
            members.slice(fromIndex + 1).map((sessionIdTo, toIndex) =>
                createRtcTopologyRttMeasurement({
                    sessionIdFrom,
                    sessionIdTo,
                    rttMs: 2 + ((fromIndex * 37 + toIndex * 11) % 10) / 10,
                    version: fromIndex * members.length + toIndex + 1
                })
            )
        );
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
    const queued = computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-compute-rtc-topology-work',
        aggregateRef: input.current.group,
        expireAtEpochMs: PUBLICATION_EXPIRE_AT_EPOCH_MS,
        timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'topology-service',
        origin: 'automatic',
        groupSnapshot: input.current,
        requestedAtEpochMs: 100,
        previousEntry: null
    }).entryWrite.entry;
    const entry = { ...queued, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
    return toWorkInput({
        entry,
        stored: input.stored,
        authority: createPlanningAuthority(input.current, input.nowEpochMs)
    });
}

/** The same work as published: with a publication expiry, the work writes a publication row. */
function toPublishingWorkInput(input: ComputeRtcTopologyWorkInput): ComputeRtcTopologyWorkInput {
    return { ...input, publicationExpireAtTimestamp: PUBLICATION_EXPIRE_AT_EPOCH_MS };
}

function computePublishedWork(input: ComputeRtcTopologyWorkInput): RtcTopologyPublication {
    const accepted = computeRtcTopologyWork(toPublishingWorkInput(input)).right?.accepted;
    if (accepted?.decision !== 'accepted' || accepted.publication === null) {
        throw new Error('The work must publish a planned layout');
    }
    return accepted.publication;
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

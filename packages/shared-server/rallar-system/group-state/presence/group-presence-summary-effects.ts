import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import type { ResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import {
    computeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
import {
    isMutableCoalescedStatus,
    type ComputedCoalescedAppOutboxWork
} from '../../app-outbox/coalesced-app-outbox-work.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import type { ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import {
    computeGroupStateSyncEntries,
    type ComputedGroupStateSyncEffect,
    type StateSyncAudience
} from '../../state-sync/state-sync-entry-computation.ts';
import {
    resolveTopologyReplanEnqueue,
    type TopologyReplanEnqueueFacts,
    type TopologyReplanPolicyFacts,
    type TopologyWorkOrigin
} from '../../topology/planning/resolve-topology-plan-action.ts';
import {
    resolveTopologyExpectedMemberCount,
    resolveTopologyReplanWindow
} from '../../topology/planning/resolve-topology-replan-window.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    type TopologyReplanTiming
} from '../../topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { assembleGroupStateSnapshot } from '../persistence/assemble-group-state-snapshot.ts';
import { PRESENCE_SUMMARIES_NAMESPACE } from '../persistence/group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../persistence/serialize-group-state-value.ts';
import {
    computeGroupPresenceSummary,
    type GroupPresenceSummaryComputed,
    type GroupPresenceSummaryRead
} from './compute-group-presence-summary.ts';

export interface GroupPresenceSummaryReservationRead {
    readonly key: Key;
    readonly expectedAttempts: number;
}

export interface GroupPresenceSummaryWorkRead {
    readonly nowEpochMs: number;
    readonly reservation: GroupPresenceSummaryReservationRead;
    readonly presence: GroupPresenceSummaryRead;
    /** Every event expanded from this read, in causal order; the first delta carries their merged slice, the others their own. */
    readonly coalescedEvents: readonly GroupEvent[];
    readonly coalescedTopologyEntry: ResourceEntry | null;
    readonly topologyReplanPolicyFacts: TopologyReplanPolicyFacts;
}

/** The replan decision: queued work, or held by the replanning policy. */
export type TopologyReplanDecision =
    | Readonly<{ decision: 'enqueue'; work: ComputedCoalescedAppOutboxWork; }>
    | Readonly<{ decision: 'held-by-policy'; }>;

export interface GroupPresenceSummaryComputedWork {
    readonly work: GroupPresenceSummaryWorkData;
    readonly summary: GroupPresenceSummaryComputed;
    readonly summaryWrite: GroupPresenceSummaryWrite | null;
    readonly snapshot: GroupSnapshot;
    readonly downstreamOutboxWrites: readonly AppOutboxInsert[];
    readonly topologyReplan: TopologyReplanDecision;
    readonly reservationFinish: ResourceInboxReservationFinish;
}

export type GroupPresenceSummaryWrite =
    | Readonly<{
        operation: 'insert';
        groupExpectedRevision: number;
        namespace: string;
        key: string;
        value: string;
        expireAtIsoTimestamp: string;
    }>
    | Readonly<{
        operation: 'update';
        namespace: string;
        key: string;
        value: string;
        expireAtIsoTimestamp: string;
        expectedRevision: number;
    }>;

export interface ComputeGroupPresenceSummaryWorkOptions {
    readonly serviceId: string;
    /** The server-wide replan window, the one every group coalesced through before per-group windows existed. */
    readonly recomputeDebounceMs: number;
    /** The server-wide bound on that window, measured from the first pending change of a series. */
    readonly recomputeMaxWaitMs: number;
    readonly minimumLayoutAgeMs: number;
}

export interface ComputeGroupPresenceSummaryOutboxInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly coalescedEvents: readonly GroupEvent[];
    readonly summary: GroupPresenceSummaryComputed;
    readonly summaryPredecessorCausalRevision: GroupStateCausalRevision | null;
    readonly snapshot: GroupSnapshot;
    readonly audience: StateSyncAudience;
    readonly serviceId: string;
    readonly traceId: string;
}

export interface ComputeGroupStateDeltaEnvelopeInput {
    readonly event: GroupEvent;
    readonly coalescedEvents: readonly GroupEvent[];
    readonly summary: GroupPresenceSummaryComputed;
    readonly summaryPredecessorCausalRevision: GroupStateCausalRevision | null;
    readonly snapshot: GroupSnapshot;
}

/** One expansion's work row and read, with the summary state of the page it belongs to. */
export interface GroupPresenceSummaryExpansionInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly state: GroupPresenceSummaryState;
    readonly traceId: string;
}

export interface ValidateGroupPresenceSummaryComputedWorkInput {
    readonly expansion: GroupPresenceSummaryExpansionInput;
    readonly computed: GroupPresenceSummaryComputedWork;
    readonly options: ComputeGroupPresenceSummaryWorkOptions;
}

interface ToGroupPresenceSummaryOutboxInputInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly summary: GroupPresenceSummaryComputed;
    readonly snapshot: GroupSnapshot;
    readonly options: ComputeGroupPresenceSummaryWorkOptions;
    readonly traceId: string;
}

/**
 * The summary a read yields and the snapshot assembled from it. Every expansion of one read shares both, so a page
 * computes them once, checks them once, and hands them to each expansion.
 */
export interface GroupPresenceSummaryState {
    readonly summary: GroupPresenceSummaryComputed;
    readonly snapshot: GroupSnapshot;
}

export function computeGroupPresenceSummaryWork(
    expansion: GroupPresenceSummaryExpansionInput,
    options: ComputeGroupPresenceSummaryWorkOptions
): GroupPresenceSummaryComputedWork {
    const { work, read, state: { summary, snapshot }, traceId } = expansion;
    const outboxInput = toGroupPresenceSummaryOutboxInput({
        work,
        read,
        summary,
        snapshot,
        options,
        traceId
    });
    const downstreamOutboxEntries = computeGroupPresenceSummaryOutboxEntries(outboxInput);
    return {
        work,
        summary,
        summaryWrite: computeGroupPresenceSummaryWrite(summary, read.presence.group.entry.revision),
        snapshot,
        downstreamOutboxWrites: downstreamOutboxEntries.map(computeAppOutboxInsert),
        topologyReplan: computeTopologyReplan({ work, read, summary, snapshot, options, traceId }),
        reservationFinish: {
            key: { ...read.reservation.key },
            expectedAttempts: read.reservation.expectedAttempts,
            status: EntityStatus.COMPLETED,
            completedAt: new Date(read.nowEpochMs)
        }
    };
}

export function computeGroupPresenceSummaryState(
    work: GroupPresenceSummaryWorkData,
    read: Pick<GroupPresenceSummaryWorkRead, 'presence' | 'nowEpochMs'>
): GroupPresenceSummaryState {
    const summary = computeGroupPresenceSummary({
        ref: work.aggregateRef,
        read: read.presence,
        nowEpochMs: read.nowEpochMs
    });
    const snapshot = assembleGroupStateSnapshot(
        {
            group: read.presence.group.value,
            members: read.presence.members.map((member) => member.value),
            summary: summary.summary,
            authoritativeSessions: read.presence.presenceSessions.map((session) => session.value),
            groupRevision: summary.summary.causalRevision.groupRevision,
            observedAtEpochMs: summary.summary.computedAtEpochMs,
            sessionLeaseFields: 'authoritative'
        },
        (storageKey, message) => new Error(`${message}: ${storageKey}`)
    );
    return { summary, snapshot };
}

/** The page's shared state against its recomputation from the read it was computed from. */
export function validateGroupPresenceSummaryState(
    work: GroupPresenceSummaryWorkData,
    read: Pick<GroupPresenceSummaryWorkRead, 'presence' | 'nowEpochMs'>,
    state: GroupPresenceSummaryState
): readonly ComputedDataValidationIssue[] {
    return validateComputedProjection(computeGroupPresenceSummaryState(work, read), state, 'state');
}

/** The revision a summary delta names as its predecessor: the stored summary's, or none before the first summary. */
export function toGroupPresenceSummaryPredecessorCausalRevision(
    presence: GroupPresenceSummaryRead
): GroupStateCausalRevision | null {
    return presence.current?.value.causalRevision ?? null;
}

function computeGroupPresenceSummaryWrite(
    computed: GroupPresenceSummaryComputed,
    groupExpectedRevision: number
): GroupPresenceSummaryWrite | null {
    if (computed.outcome === 'no-op') {
        return null;
    }
    const persisted = {
        namespace: PRESENCE_SUMMARIES_NAMESPACE,
        key: groupStateGroupStorageKey(computed.summary),
        value: serializeGroupStateValue(computed.summary),
        expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
    };
    return computed.operation === 'insert'
        ? { ...persisted, operation: 'insert', groupExpectedRevision }
        : {
            ...persisted,
            operation: 'update',
            expectedRevision: computed.expectedRevision
        };
}

/** The facts the enqueue gate reads from the presence-summary command and the group it summarizes. */
export function toTopologyReplanEnqueueFacts(
    work: GroupPresenceSummaryWorkData,
    group: Group,
    read: Readonly<{ coalescedTopologyEntry: ResourceEntry | null; nowEpochMs: number; }>
): TopologyReplanEnqueueFacts {
    return {
        group,
        nowEpochMs: read.nowEpochMs,
        workOrigin: toTopologyReplanOrigin(work),
        mergeableHeadRow: read.coalescedTopologyEntry !== null &&
            isMutableCoalescedStatus(read.coalescedTopologyEntry.status)
    };
}

export function toTopologyReplanOrigin(work: GroupPresenceSummaryWorkData): TopologyWorkOrigin {
    return work.event.payload.topologyReplanOrigin === 'commanded' ? 'commanded' : 'automatic';
}

function computeTopologyReplan(input: ToGroupPresenceSummaryOutboxInputInput): TopologyReplanDecision {
    const { work, read, summary, snapshot, options } = input;
    const enqueue = resolveTopologyReplanEnqueue({
        ...toTopologyReplanEnqueueFacts(work, snapshot.group, {
            coalescedTopologyEntry: read.coalescedTopologyEntry,
            nowEpochMs: read.nowEpochMs
        }),
        policyFacts: read.topologyReplanPolicyFacts
    });
    if (enqueue === 'held-by-policy') {
        return { decision: 'held-by-policy' };
    }
    return {
        decision: 'enqueue',
        work: computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: work.aggregateRef,
            groupSnapshot: snapshot,
            requestedAtEpochMs: summary.summary.computedAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            timing: toTopologyReplanTiming({ read, snapshot, options }),
            senderId: options.serviceId,
            origin: toTopologyReplanOrigin(work),
            previousEntry: read.coalescedTopologyEntry,
            traceId: input.traceId
        })
    };
}

interface ToTopologyReplanTimingInput {
    readonly read: GroupPresenceSummaryWorkRead;
    readonly snapshot: GroupSnapshot;
    readonly options: Pick<
        ComputeGroupPresenceSummaryWorkOptions,
        'recomputeDebounceMs' | 'recomputeMaxWaitMs' | 'minimumLayoutAgeMs'
    >;
}

/** The replan window, the layout-age floor and the expected-member arrival, from the facts the read consulted for this stage. */
function toTopologyReplanTiming(input: ToTopologyReplanTimingInput): TopologyReplanTiming {
    const { read, snapshot, options } = input;
    const policyFacts = read.topologyReplanPolicyFacts;
    const expectedMembersArrived = computeExpectedMembersArrived(
        snapshot,
        read.presence.current?.value ?? null,
        resolveTopologyExpectedMemberCount(snapshot.group, policyFacts.consulted ? policyFacts.lifecyclePolicy : null)
    );
    if (!policyFacts.consulted) {
        return {
            window: { debounceMs: options.recomputeDebounceMs, maxWaitMs: options.recomputeMaxWaitMs },
            replanNotBeforeEpochMs: null,
            expectedMembersArrived
        };
    }
    const { plannedLayout } = policyFacts;
    return {
        window: resolveTopologyReplanWindow({
            lifecyclePolicy: policyFacts.lifecyclePolicy,
            serverDebounceMs: options.recomputeDebounceMs,
            serverMaxWaitMs: options.recomputeMaxWaitMs
        }),
        // Only a live planned layout ages; a removal tombstone carries the
        // group's last update, not a layout write.
        replanNotBeforeEpochMs: plannedLayout?.state === 'active'
            ? plannedLayout.updatedAtEpochMs + options.minimumLayoutAgeMs
            : null,
        expectedMembersArrived
    };
}

/** Whether this summary brings the present members up to the expected count from below it. */
function computeExpectedMembersArrived(
    snapshot: GroupSnapshot,
    previousSummary: GroupPresenceSummary | null,
    expectedMemberCount: number | null
): boolean {
    if (expectedMemberCount === null || snapshot.onlineMemberCount < expectedMemberCount) {
        return false;
    }
    const previouslyPresent = new Set(previousSummary?.activePrincipalIds ?? []);
    const previousOnlineMemberCount =
        snapshot.members.filter((member) => member.status === 'active' && previouslyPresent.has(member.principalId))
            .length;
    return previousOnlineMemberCount < expectedMemberCount;
}

export function validateGroupPresenceSummaryComputedWork(
    input: ValidateGroupPresenceSummaryComputedWorkInput
): readonly ComputedDataValidationIssue[] {
    const expected = computeGroupPresenceSummaryWork(input.expansion, input.options);
    return validateComputedProjection(expected, input.computed, 'computed');
}

function toGroupPresenceSummaryOutboxInput(
    input: ToGroupPresenceSummaryOutboxInputInput
): ComputeGroupPresenceSummaryOutboxInput {
    const { work, read, summary, snapshot, options, traceId } = input;
    return {
        work,
        coalescedEvents: read.coalescedEvents,
        summary,
        summaryPredecessorCausalRevision: toGroupPresenceSummaryPredecessorCausalRevision(read.presence),
        snapshot,
        audience: {
            kind: 'group',
            applicationId: work.aggregateRef.applicationId,
            workspaceId: work.aggregateRef.workspaceId,
            resourceId: work.aggregateRef.groupId
        },
        serviceId: options.serviceId,
        traceId
    };
}

function computeGroupPresenceSummaryOutboxEntries(
    input: ComputeGroupPresenceSummaryOutboxInput
): readonly ResourceEntry[] {
    const { work, audience, serviceId, traceId } = input;
    return computeGroupStateSyncEntries(
        {
            commandId: work.commandId,
            aggregateRef: work.aggregateRef,
            acceptedCausalRevision: work.acceptedCausalRevision,
            audience,
            createdAtEpochMs: work.createdAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            effects: [computeGroupStateEventEffect(input)],
            traceId
        },
        serviceId
    );
}

function computeGroupStateEventEffect(
    input: ComputeGroupPresenceSummaryOutboxInput
): ComputedGroupStateSyncEffect {
    return {
        effectKind: 'member-state',
        payloadKind: 'delta-envelope',
        payload: computeGroupStateDeltaEnvelope({
            event: input.work.event,
            coalescedEvents: input.coalescedEvents,
            summary: input.summary,
            summaryPredecessorCausalRevision: input.summaryPredecessorCausalRevision,
            snapshot: input.snapshot
        })
    };
}

export function computeGroupStateDeltaEnvelope(
    input: ComputeGroupStateDeltaEnvelopeInput
): GroupStateDeltaEnvelope {
    const { event, snapshot } = input;
    const sliceEvents = resolveGroupStateDeltaSliceEvents(event, input.coalescedEvents);
    const activeSessionIds = snapshot.activeSessions.map((session) => session.sessionId);
    return {
        event,
        predecessorCausalRevision: resolveGroupStateDeltaPredecessorCausalRevision(input),
        resultingCausalRevision: snapshot.causalRevision,
        members: snapshot.members.filter((member) =>
            sliceEvents.some((sliced) => isGroupMemberWrittenByEvent(member, sliced))
        ),
        removedMemberPrincipalIds: [],
        sessions: computeGroupStateDeltaSessions(sliceEvents, snapshot),
        removedSessionIds: computeGroupStateDeltaRemovedSessionIds(sliceEvents, activeSessionIds),
        activeSessionIds,
        group: snapshot.group,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        audienceSessionIds: input.summary.summary.activeSessionIds
    };
}

/** The first delta of a coalesced batch carries the whole batch's slice; every later delta carries its own event's. */
function resolveGroupStateDeltaSliceEvents(
    event: GroupEvent,
    coalescedEvents: readonly GroupEvent[]
): readonly GroupEvent[] {
    return coalescedEvents[0]?.eventId === event.eventId ? coalescedEvents : [event];
}

function computeGroupStateDeltaRemovedSessionIds(
    sliceEvents: readonly GroupEvent[],
    activeSessionIds: readonly string[]
): readonly string[] {
    const active = new Set(activeSessionIds);
    const removed = new Set<string>();
    for (const sliced of sliceEvents) {
        if (
            sliced.eventType === 'session-disconnected' &&
            sliced.actor.kind === 'session' &&
            !active.has(sliced.actor.sessionId)
        ) {
            removed.add(sliced.actor.sessionId);
        }
    }
    return [...removed];
}

function resolveGroupStateDeltaPredecessorCausalRevision(
    input: ComputeGroupStateDeltaEnvelopeInput
): GroupStateCausalRevision {
    const resulting = input.snapshot.causalRevision;
    if (input.summary.outcome === 'no-op') {
        return resulting;
    }
    if (input.summaryPredecessorCausalRevision !== null) {
        return input.summaryPredecessorCausalRevision;
    }
    return {
        groupRevision: resulting.groupRevision,
        presenceRevision: resulting.presenceRevision - 1
    };
}

function isGroupMemberWrittenByEvent(member: GroupMember, event: GroupEvent): boolean {
    return member.updated.atEpochMs === event.occurredAtEpochMs &&
        member.updated.requestId === event.requestId;
}

function computeGroupStateDeltaSessions(
    coalescedEvents: readonly GroupEvent[],
    snapshot: GroupSnapshot
): readonly GroupPresenceSession[] {
    const principalIds = new Set(
        coalescedEvents.flatMap((event) =>
            (event.eventType === 'session-connected' ||
                    event.eventType === 'session-heartbeat' ||
                    event.eventType === 'session-disconnected') &&
                event.actor.kind !== 'service'
                ? [event.actor.principalId]
                : []
        )
    );
    return snapshot.activeSessions.filter((session) => principalIds.has(session.principalId));
}

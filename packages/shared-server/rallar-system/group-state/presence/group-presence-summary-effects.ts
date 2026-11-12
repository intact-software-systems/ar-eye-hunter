import { comparePublicationGrantPrincipalIds } from '@shared/api/group-publication/group-publication-grants.ts';
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
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
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
import { computeGroupDeltaOutboxWrites } from './compute-group-delta-outbox-writes.ts';
import {
    computeGroupPresenceSummary,
    isGroupPresenceSessionContentEqual,
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

/** The replan decision: queued work, held by the replanning policy, or nothing to plan after a key-only change. */
export type TopologyReplanDecision =
    | Readonly<{ decision: 'enqueue'; work: ComputedCoalescedAppOutboxWork; }>
    | Readonly<{ decision: 'held-by-policy'; }>
    | Readonly<{ decision: 'no-topology-change'; }>;

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
    /** The WS service peer that sends the group-state delta, the peer its receivers acknowledge. */
    readonly senderPeerId: string;
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
    readonly predecessorCausalRevision: GroupStateCausalRevision;
    readonly snapshot: GroupSnapshot;
    readonly audience: StateSyncAudience;
    readonly senderPeerId: string;
    readonly traceId: string;
}

export interface ComputeGroupStateDeltaEnvelopeInput {
    readonly event: GroupEvent;
    readonly coalescedEvents: readonly GroupEvent[];
    readonly summary: GroupPresenceSummaryComputed;
    readonly predecessorCausalRevision: GroupStateCausalRevision;
    readonly snapshot: GroupSnapshot;
}

/** One expansion's work row and read, with the summary state of the page it belongs to. */
export interface GroupPresenceSummaryExpansionInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly state: GroupPresenceSummaryState;
    /** The predecessor every delta of the page names, resolved once for the page. */
    readonly deltaPredecessorCausalRevision: GroupStateCausalRevision;
    readonly traceId: string;
}

export interface ResolveGroupStateDeltaPredecessorInput {
    /** The page's events in causal order. */
    readonly coalescedEvents: readonly GroupEvent[];
    readonly state: GroupPresenceSummaryState;
    /** The rows the page read; their stored summary is the state a consumer at the predecessor revision holds. */
    readonly presence: GroupPresenceSummaryRead;
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
    readonly predecessorCausalRevision: GroupStateCausalRevision;
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
    const expansionInput = {
        work,
        read,
        summary,
        snapshot,
        predecessorCausalRevision: expansion.deltaPredecessorCausalRevision,
        options,
        traceId
    };
    const outboxInput = toGroupPresenceSummaryOutboxInput(expansionInput);
    const downstreamOutboxEntries = computeGroupPresenceSummaryOutboxEntries(outboxInput);
    return {
        work,
        summary,
        summaryWrite: computeGroupPresenceSummaryWrite(summary, read.presence.group.entry.revision),
        snapshot,
        downstreamOutboxWrites: computeGroupDeltaOutboxWrites({
            entries: downstreamOutboxEntries,
            groupRef: work.aggregateRef,
            activeSessionIds: summary.summary.activeSessionIds
        }),
        topologyReplan: computeTopologyReplan(expansionInput),
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
            publicationGrants: read.presence.publicationGrants.map((grant) => grant.value),
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

/** The summary a delta names as its predecessor: the stored one, or none before the first summary. */
function toGroupPresenceSummaryPredecessor(presence: GroupPresenceSummaryRead): GroupPresenceSummary | null {
    return presence.current?.value ?? null;
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
    const origin = toTopologyReplanOrigin(work);
    // Commanded work always runs; automatic work after a change of publication keys alone has no input to plan from.
    if (
        origin === 'automatic' && summary.outcome === 'write' && summary.operation === 'update' &&
        summary.publicationKeysOnly
    ) {
        return { decision: 'no-topology-change' };
    }
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
            origin,
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
    const { expansion } = input;
    const deltaPredecessorCausalRevision = resolveGroupStateDeltaPredecessorCausalRevision({
        coalescedEvents: expansion.read.coalescedEvents,
        state: expansion.state,
        presence: expansion.read.presence
    });
    return [
        ...validateComputedProjection(
            deltaPredecessorCausalRevision,
            expansion.deltaPredecessorCausalRevision,
            'deltaPredecessorCausalRevision'
        ),
        ...validateComputedProjection(
            computeGroupPresenceSummaryWork(expansion, input.options),
            input.computed,
            'computed'
        )
    ];
}

function toGroupPresenceSummaryOutboxInput(
    input: ToGroupPresenceSummaryOutboxInputInput
): ComputeGroupPresenceSummaryOutboxInput {
    const { work, read, summary, snapshot, options, traceId } = input;
    return {
        work,
        coalescedEvents: read.coalescedEvents,
        summary,
        predecessorCausalRevision: input.predecessorCausalRevision,
        snapshot,
        audience: {
            kind: 'group',
            applicationId: work.aggregateRef.applicationId,
            workspaceId: work.aggregateRef.workspaceId,
            resourceId: work.aggregateRef.groupId
        },
        senderPeerId: options.senderPeerId,
        traceId
    };
}

function computeGroupPresenceSummaryOutboxEntries(
    input: ComputeGroupPresenceSummaryOutboxInput
): readonly ResourceEntry[] {
    const { work, audience, senderPeerId, traceId } = input;
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
        senderPeerId
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
            predecessorCausalRevision: input.predecessorCausalRevision,
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
        predecessorCausalRevision: input.predecessorCausalRevision,
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
        audienceSessionIds: input.summary.summary.activeSessionIds,
        ...computeGroupStateDeltaPublicationGrants(sliceEvents, snapshot)
    };
}

/**
 * The rows of the principals the slice's events wrote: a grant change's principal, and every member an event wrote,
 * which covers the creator on `group-created` and a departing holder; a written principal without a row is removed.
 */
function computeGroupStateDeltaPublicationGrants(
    sliceEvents: readonly GroupEvent[],
    snapshot: GroupSnapshot
): Pick<GroupStateDeltaEnvelope, 'publicationGrants' | 'removedPublicationGrantPrincipalIds'> {
    const written = new Set(sliceEvents.flatMap((event) => [
        ...(event.eventType === 'publication-grant-changed' && typeof event.payload.principalId === 'string'
            ? [event.payload.principalId]
            : []),
        ...snapshot.members.filter((member) => isGroupMemberWrittenByEvent(member, event)).map((member) =>
            member.principalId
        )
    ]));
    const publicationGrants = snapshot.publicationGrants.filter((grant) => written.has(grant.principalId));
    const granted = new Set(publicationGrants.map((grant) => grant.principalId));
    return {
        publicationGrants,
        removedPublicationGrantPrincipalIds: [...written].filter((principalId) => !granted.has(principalId)).sort(
            comparePublicationGrantPrincipalIds
        )
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

/**
 * The predecessor every delta of a page names. A delta claims the write from the summary predecessor to the snapshot
 * only when the page's batch carries it: a summary no-op, or a snapshot the batch does not cover, names the snapshot
 * itself, and a consumer behind it pulls the snapshot rather than label rows the batch does not carry.
 */
export function resolveGroupStateDeltaPredecessorCausalRevision(
    input: ResolveGroupStateDeltaPredecessorInput
): GroupStateCausalRevision {
    const { coalescedEvents, state: { summary, snapshot } } = input;
    const summaryPredecessor = toGroupPresenceSummaryPredecessor(input.presence);
    const resulting = snapshot.causalRevision;
    if (summary.outcome === 'no-op' || !isSnapshotCoveredByDeltaBatch(coalescedEvents, snapshot, summaryPredecessor)) {
        return resulting;
    }
    if (summaryPredecessor !== null) {
        return summaryPredecessor.causalRevision;
    }
    return {
        groupRevision: resulting.groupRevision,
        presenceRevision: resulting.presenceRevision - 1
    };
}

/**
 * Every group revision after the predecessor's is a group write of the batch, which relies on each such write advancing
 * the group revision by exactly one; and every session whose content changed belongs to a principal whose session event
 * is in the batch. Before the first summary there is no predecessor revision, so the batch's newest event bounds the
 * range.
 */
function isSnapshotCoveredByDeltaBatch(
    coalescedEvents: readonly GroupEvent[],
    snapshot: GroupSnapshot,
    summaryPredecessor: GroupPresenceSummary | null
): boolean {
    const writtenGroupRevisions = new Set(
        coalescedEvents.filter((event) => !isGroupSessionEvent(event)).map((event) =>
            event.causalRevision.groupRevision
        )
    );
    const floor = summaryPredecessor?.causalRevision.groupRevision ??
        Math.max(...coalescedEvents.map((event) => event.causalRevision.groupRevision));
    for (let revision = floor + 1; revision <= snapshot.causalRevision.groupRevision; revision += 1) {
        if (!writtenGroupRevisions.has(revision)) {
            return false;
        }
    }
    const writtenPrincipalIds = toGroupStateDeltaSessionPrincipalIds(coalescedEvents);
    const previousSessions = new Map(
        (summaryPredecessor?.activeSessions ?? []).map((session) => [session.sessionId, session])
    );
    return snapshot.activeSessions.every((session) => {
        const previous = previousSessions.get(session.sessionId);
        return previous === undefined || writtenPrincipalIds.has(session.principalId) ||
            isGroupPresenceSessionContentEqual(previous, session);
    });
}

function isGroupMemberWrittenByEvent(member: GroupMember, event: GroupEvent): boolean {
    return member.updated.atEpochMs === event.occurredAtEpochMs &&
        member.updated.requestId === event.requestId;
}

function computeGroupStateDeltaSessions(
    coalescedEvents: readonly GroupEvent[],
    snapshot: GroupSnapshot
): readonly GroupPresenceSession[] {
    const principalIds = toGroupStateDeltaSessionPrincipalIds(coalescedEvents);
    return snapshot.activeSessions.filter((session) => principalIds.has(session.principalId));
}

/** The principals whose sessions the events wrote: the actors of their session events. */
function toGroupStateDeltaSessionPrincipalIds(events: readonly GroupEvent[]): ReadonlySet<string> {
    return new Set(
        events.flatMap((event) =>
            isGroupSessionEvent(event) && event.actor.kind !== 'service' ? [event.actor.principalId] : []
        )
    );
}

/**
 * A presence write's event: it keeps the group revision it read. Every other group event is the write that advanced
 * the group to its revision.
 */
export function isGroupSessionEvent(event: GroupEvent): boolean {
    return event.eventType === 'session-connected' ||
        event.eventType === 'session-heartbeat' ||
        event.eventType === 'session-disconnected';
}

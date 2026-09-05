import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
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
import { resolveTopologyReplanWindow } from '../../topology/planning/resolve-topology-replan-window.ts';
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
    readonly coalescedTopologyEntry: ResourceEntry | null;
    readonly topologyReplanPolicyFacts: TopologyReplanPolicyFacts;
}

/** The replan decision (product decision 2): queued work, or held by the replanning policy. */
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
    readonly minimumLayoutAgeMs: number;
}

export interface ComputeGroupPresenceSummaryOutboxInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly summary: GroupPresenceSummaryComputed;
    readonly summaryPredecessorCausalRevision: GroupStateCausalRevision | null;
    readonly snapshot: GroupSnapshot;
    readonly audience: StateSyncAudience;
    readonly serviceId: string;
}

export interface ComputeGroupStateDeltaEnvelopeInput {
    readonly event: GroupEvent;
    readonly summary: GroupPresenceSummaryComputed;
    readonly summaryPredecessorCausalRevision: GroupStateCausalRevision | null;
    readonly snapshot: GroupSnapshot;
}

export interface ValidateGroupPresenceSummaryComputedWorkInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly computed: GroupPresenceSummaryComputedWork;
    readonly options: ComputeGroupPresenceSummaryWorkOptions;
}

interface ToGroupPresenceSummaryOutboxInputInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly summary: GroupPresenceSummaryComputed;
    readonly snapshot: GroupSnapshot;
    readonly options: ComputeGroupPresenceSummaryWorkOptions;
}

export function computeGroupPresenceSummaryWork(
    work: GroupPresenceSummaryWorkData,
    read: GroupPresenceSummaryWorkRead,
    options: ComputeGroupPresenceSummaryWorkOptions
): GroupPresenceSummaryComputedWork {
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
    const outboxInput = toGroupPresenceSummaryOutboxInput({
        work,
        read,
        summary,
        snapshot,
        options
    });
    const downstreamOutboxEntries = computeGroupPresenceSummaryOutboxEntries(outboxInput);
    return {
        work,
        summary,
        summaryWrite: computeGroupPresenceSummaryWrite(summary),
        snapshot,
        downstreamOutboxWrites: downstreamOutboxEntries.map(computeAppOutboxInsert),
        topologyReplan: computeTopologyReplan({ work, read, summary, snapshot, options }),
        reservationFinish: {
            key: { ...read.reservation.key },
            expectedAttempts: read.reservation.expectedAttempts,
            status: EntityStatus.COMPLETED,
            completedAt: new Date(read.nowEpochMs)
        }
    };
}

function computeGroupPresenceSummaryWrite(
    computed: GroupPresenceSummaryComputed
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
        ? { ...persisted, operation: 'insert' }
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

function toTopologyReplanOrigin(work: GroupPresenceSummaryWorkData): TopologyWorkOrigin {
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
            timing: toTopologyReplanTiming(read.topologyReplanPolicyFacts, options),
            senderId: options.serviceId,
            origin: toTopologyReplanOrigin(work),
            previousEntry: read.coalescedTopologyEntry
        })
    };
}

/** The replan window and the layout-age floor, from the policy facts the read consulted for this stage. */
function toTopologyReplanTiming(
    policyFacts: TopologyReplanPolicyFacts,
    options: Pick<ComputeGroupPresenceSummaryWorkOptions, 'recomputeDebounceMs' | 'minimumLayoutAgeMs'>
): TopologyReplanTiming {
    if (!policyFacts.consulted) {
        return { window: { debounceMs: options.recomputeDebounceMs, maxWaitMs: null }, replanNotBeforeEpochMs: null };
    }
    const { plannedLayout } = policyFacts;
    return {
        window: resolveTopologyReplanWindow({
            lifecyclePolicy: policyFacts.lifecyclePolicy,
            serverDebounceMs: options.recomputeDebounceMs
        }),
        // Only a live planned layout ages; a removal tombstone carries the
        // group's last update, not a layout write.
        replanNotBeforeEpochMs: plannedLayout?.state === 'active'
            ? plannedLayout.updatedAtEpochMs + options.minimumLayoutAgeMs
            : null
    };
}

export function validateGroupPresenceSummaryComputedWork(
    input: ValidateGroupPresenceSummaryComputedWorkInput
): readonly ComputedDataValidationIssue[] {
    const expected = computeGroupPresenceSummaryWork(
        input.work,
        input.read,
        input.options
    );
    return validateComputedProjection(expected, input.computed, 'computed');
}

function toGroupPresenceSummaryOutboxInput(
    input: ToGroupPresenceSummaryOutboxInputInput
): ComputeGroupPresenceSummaryOutboxInput {
    const { work, read, summary, snapshot, options } = input;
    return {
        work,
        summary,
        summaryPredecessorCausalRevision: read.presence.current?.value.causalRevision ?? null,
        snapshot,
        audience: {
            kind: 'group',
            applicationId: work.aggregateRef.applicationId,
            workspaceId: work.aggregateRef.workspaceId,
            resourceId: work.aggregateRef.groupId
        },
        serviceId: options.serviceId
    };
}

function computeGroupPresenceSummaryOutboxEntries(
    input: ComputeGroupPresenceSummaryOutboxInput
): readonly ResourceEntry[] {
    const { work, audience, serviceId } = input;
    return computeGroupStateSyncEntries(
        {
            commandId: work.commandId,
            aggregateRef: work.aggregateRef,
            acceptedCausalRevision: work.acceptedCausalRevision,
            audience,
            createdAtEpochMs: work.createdAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            effects: [computeGroupStateEventEffect(input)]
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
    const activeSessionIds = snapshot.activeSessions.map((session) => session.sessionId);
    const removedSessionIds = event.eventType === 'session-disconnected' &&
            event.actor.kind === 'session' &&
            !activeSessionIds.includes(event.actor.sessionId)
        ? [event.actor.sessionId]
        : [];
    return {
        event,
        predecessorCausalRevision: resolveGroupStateDeltaPredecessorCausalRevision(input),
        resultingCausalRevision: snapshot.causalRevision,
        members: snapshot.members.filter((member) => isGroupMemberWrittenByEvent(member, event)),
        removedMemberPrincipalIds: [],
        sessions: computeGroupStateDeltaSessions(event, snapshot),
        removedSessionIds,
        activeSessionIds,
        group: snapshot.group,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        audienceSessionIds: input.summary.summary.activeSessionIds
    };
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
    event: GroupEvent,
    snapshot: GroupSnapshot
): readonly GroupPresenceSession[] {
    if (
        event.eventType !== 'session-connected' &&
        event.eventType !== 'session-heartbeat' &&
        event.eventType !== 'session-disconnected'
    ) {
        return [];
    }
    if (event.actor.kind === 'service') {
        return [];
    }
    const principalId = event.actor.principalId;
    return snapshot.activeSessions.filter(
        (session) => session.principalId === principalId
    );
}

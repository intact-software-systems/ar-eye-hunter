import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
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
import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';
import { computeAppOutboxInsertOrMatch, type AppOutboxInsertOrMatch } from '../../app-outbox/app-outbox-insert.ts';
import {
    validateCoalescedAppOutboxWrite,
    type ComputedCoalescedAppOutboxWork
} from '../../app-outbox/coalesced-app-outbox-work.ts';
import {
    computeGroupStateSyncEntries,
    type ComputedGroupStateSyncEffect,
    type StateSyncAudience
} from '../../state-sync/state-sync-entry-computation.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork
} from '../../topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../group-state-validation-issues.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { assembleGroupStateSnapshot } from '../persistence/assemble-group-state-snapshot.ts';
import { PRESENCE_SUMMARIES_NAMESPACE } from '../persistence/group-state-runtime-namespaces.ts';
import {
    computeGroupPresenceSummary,
    validateGroupPresenceSummaryCandidate,
    validateGroupPresenceSummaryRead,
    type GroupPresenceSummaryComputed,
    type GroupPresenceSummaryRead
} from './compute-group-presence-summary.ts';

export interface GroupPresenceSummaryWorkRead {
    readonly presence: GroupPresenceSummaryRead;
    readonly coalescedTopologyEntry: ResourceEntry | null;
    readonly nowEpochMs: number;
    readonly serviceId: string;
    readonly recomputeDebounceMs: number;
    readonly reservation: Readonly<{
        key: Key;
        expectedAttempts: number;
    }>;
}

export interface GroupPresenceSummaryComputedWork {
    readonly work: GroupPresenceSummaryWorkData;
    readonly summary: GroupPresenceSummaryComputed;
    readonly summaryWrite: GroupPresenceSummaryRuntimeWrite | null;
    readonly snapshot: GroupSnapshot;
    readonly downstreamOutboxWrites: readonly AppOutboxInsertOrMatch[];
    readonly coalescedTopologyWork: ComputedCoalescedAppOutboxWork;
    readonly reservationFinish: ResourceInboxReservationFinish;
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
}

interface GroupPresenceSummaryRuntimeWrite {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expireAtIsoTimestamp: string;
    readonly expectedRevision: number | null;
}

interface ToGroupPresenceSummaryOutboxInputInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly summary: GroupPresenceSummaryComputed;
    readonly snapshot: GroupSnapshot;
    readonly serviceId: string;
}

export function computeGroupPresenceSummaryWork(
    work: GroupPresenceSummaryWorkData,
    read: GroupPresenceSummaryWorkRead
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
        serviceId: read.serviceId
    });
    return {
        work,
        summary,
        summaryWrite: computeGroupPresenceSummaryRuntimeWrite(summary),
        snapshot,
        downstreamOutboxWrites: computeGroupPresenceSummaryOutboxEntries(outboxInput).map(
            computeAppOutboxInsertOrMatch
        ),
        coalescedTopologyWork: computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: work.aggregateRef,
            groupSnapshot: snapshot,
            requestedAtEpochMs: summary.summary.computedAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            recomputeDebounceMs: read.recomputeDebounceMs,
            senderId: read.serviceId,
            origin: work.event.payload.topologyReplanOrigin === 'commanded'
                ? 'commanded'
                : 'automatic',
            previousEntry: read.coalescedTopologyEntry
        }),
        reservationFinish: {
            key: read.reservation.key,
            expectedAttempts: read.reservation.expectedAttempts,
            status: EntityStatus.COMPLETED,
            completedAt: new Date(read.nowEpochMs)
        }
    };
}

export function validateGroupPresenceSummaryComputedWork(
    input: ValidateGroupPresenceSummaryComputedWorkInput
): readonly GroupStateValidationIssue[] {
    const { work, read, computed } = input;
    const issues = [...validateGroupPresenceSummaryRead(work.aggregateRef, read.presence)];
    if (issues.length > 0) {
        return issues;
    }
    issues.push(
        ...validateAppInboxComputedProjection(computeGroupPresenceSummaryWork(work, read), computed, 'presenceSummary')
    );
    if (issues.length > 0) {
        return issues;
    }
    issues.push(...validateGroupPresenceSummaryCandidate({
        ref: work.aggregateRef,
        read: read.presence,
        computed: computed.summary
    }));
    if (computed.work !== work) {
        issues.push(toGroupStateValidationIssue('work', 'Presence-summary computed work differs from its command'));
    }
    issues.push(...validateCoalescedAppOutboxWrite(read.coalescedTopologyEntry, computed.coalescedTopologyWork));
    if (
        work.event.applicationId !== work.aggregateRef.applicationId ||
        work.event.workspaceId !== work.aggregateRef.workspaceId ||
        work.event.groupId !== work.aggregateRef.groupId ||
        work.event.causalRevision.groupRevision !== work.acceptedCausalRevision.groupRevision ||
        work.event.causalRevision.presenceRevision !== work.acceptedCausalRevision.presenceRevision
    ) {
        issues.push(
            toGroupStateValidationIssue('work.event', 'Presence-summary event differs from accepted group revision')
        );
    }
    return issues;
}

function computeGroupPresenceSummaryRuntimeWrite(
    summary: GroupPresenceSummaryComputed
): GroupPresenceSummaryRuntimeWrite | null {
    if (summary.outcome === 'no-op') {
        return null;
    }
    return {
        namespace: PRESENCE_SUMMARIES_NAMESPACE,
        key: groupStateGroupStorageKey(summary.summary),
        value: JSON.stringify(summary.summary),
        expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString(),
        expectedRevision: summary.expectedRevision
    };
}

function toGroupPresenceSummaryOutboxInput(
    input: ToGroupPresenceSummaryOutboxInputInput
): ComputeGroupPresenceSummaryOutboxInput {
    const { work, read, summary, snapshot, serviceId } = input;
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
        serviceId
    };
}

export function computeGroupPresenceSummaryOutboxEntries(
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

export function validateGroupPresenceSummaryOutboxEntries(
    computedEntries: readonly ResourceEntry[],
    input: ComputeGroupPresenceSummaryOutboxInput
): readonly GroupStateValidationIssue[] {
    return validateAppInboxComputedProjection(
        computeGroupPresenceSummaryOutboxEntries(input),
        computedEntries,
        'presenceSummary.downstreamOutboxEntries'
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

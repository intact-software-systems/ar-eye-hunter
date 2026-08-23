import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type {
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { ComputedCoalescedAppOutboxWork } from '../../app-outbox/coalesced-app-outbox-work-service.ts';
import {
    computeGroupStateSyncEntries,
    type ComputedGroupStateSyncEffect,
    type StateSyncAudience
} from '../../state-sync/state-sync-entry-computation.ts';
import {
    computeRtcTopologyEntry,
    deriveRtcTopologyEntryResourceId,
    type ComputedRtcTopologyOutbox
} from '../../topology/mutation/rtc-topology-outbox-entry.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork
} from '../../topology/replay/rtc-topology-coalesced-group-revision-work.ts';
import { assembleGroupStateSnapshot } from '../persistence/assemble-group-state-snapshot.ts';
import {
    computeGroupPresenceSummary,
    validateGroupPresenceSummary,
    type GroupPresenceSummaryComputed,
    type GroupPresenceSummaryRead
} from './compute-group-presence-summary.ts';

export type GroupStateDisseminationMode = 'dual-emit' | 'delta-primary';

export interface GroupPresenceSummaryWorkRead {
    readonly presence: GroupPresenceSummaryRead;
    readonly coalescedTopologyEntry: ResourceEntry | null;
}

export interface GroupPresenceSummaryComputedWork {
    readonly work: GroupPresenceSummaryWorkData;
    readonly summary: GroupPresenceSummaryComputed;
    readonly snapshot: GroupSnapshot;
    readonly downstreamOutboxEntries: readonly ResourceEntry[];
    readonly coalescedTopologyWork: ComputedCoalescedAppOutboxWork | null;
}

export interface ComputeGroupPresenceSummaryWorkOptions {
    readonly serviceId: string;
    readonly nowEpochMs: number;
    readonly recomputeDebounceMs: number;
    readonly disseminationMode: GroupStateDisseminationMode;
}

export interface ComputeGroupPresenceSummaryOutboxInput {
    readonly work: GroupPresenceSummaryWorkData;
    readonly summary: GroupPresenceSummaryComputed;
    readonly summaryPredecessorCausalRevision: GroupStateCausalRevision | null;
    readonly snapshot: GroupSnapshot;
    readonly audience: StateSyncAudience;
    readonly serviceId: string;
    readonly disseminationMode: GroupStateDisseminationMode;
    readonly includePerCommandTopologyEntry: boolean;
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
    readonly options: Omit<ComputeGroupPresenceSummaryWorkOptions, 'nowEpochMs'>;
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
        nowEpochMs: options.nowEpochMs
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
    return {
        work,
        summary,
        snapshot,
        downstreamOutboxEntries: computeGroupPresenceSummaryOutboxEntries(outboxInput),
        coalescedTopologyWork: computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: work.aggregateRef,
            groupSnapshot: snapshot,
            requestedAtEpochMs: summary.summary.computedAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            recomputeDebounceMs: options.recomputeDebounceMs,
            senderId: options.serviceId,
            previousEntry: read.coalescedTopologyEntry
        })
    };
}

export function validateGroupPresenceSummaryComputedWork(
    input: ValidateGroupPresenceSummaryComputedWorkInput
): void {
    const { work, read, computed, options } = input;
    if (computed.work !== work) {
        throw new TypeError('Presence-summary computed work differs from its command');
    }
    validateGroupPresenceSummary({
        ref: work.aggregateRef,
        read: read.presence,
        computed: computed.summary
    });
    if (
        work.event.applicationId !== work.aggregateRef.applicationId ||
        work.event.workspaceId !== work.aggregateRef.workspaceId ||
        work.event.groupId !== work.aggregateRef.groupId ||
        work.event.causalRevision.groupRevision !== work.acceptedCausalRevision.groupRevision ||
        work.event.causalRevision.presenceRevision !== work.acceptedCausalRevision.presenceRevision
    ) {
        throw new TypeError('Presence-summary event differs from accepted group revision');
    }
    validateGroupPresenceSummaryOutboxEntries(
        computed.downstreamOutboxEntries,
        toGroupPresenceSummaryOutboxInput({
            work,
            read,
            summary: computed.summary,
            snapshot: computed.snapshot,
            options: { ...options, nowEpochMs: computed.summary.summary.computedAtEpochMs }
        })
    );
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
        serviceId: options.serviceId,
        disseminationMode: options.disseminationMode,
        includePerCommandTopologyEntry: false
    };
}

export function computeGroupPresenceSummaryOutboxEntries(
    input: ComputeGroupPresenceSummaryOutboxInput
): readonly ResourceEntry[] {
    const { work, audience, serviceId } = input;
    const eventEntries = computeGroupStateSyncEntries(
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
    const snapshotEntries = input.disseminationMode === 'delta-primary'
        ? []
        : computeGroupSnapshotSyncEntries(input);
    return input.includePerCommandTopologyEntry
        ? [...eventEntries, ...snapshotEntries, computeGroupPresenceTopologyOutboxEntry(input)]
        : [...eventEntries, ...snapshotEntries];
}

function computeGroupSnapshotSyncEntries(
    input: ComputeGroupPresenceSummaryOutboxInput
): readonly ResourceEntry[] {
    const { work, summary, snapshot, audience, serviceId } = input;
    return computeGroupStateSyncEntries(
        {
            commandId: work.commandId,
            aggregateRef: work.aggregateRef,
            acceptedCausalRevision: snapshot.causalRevision,
            audience,
            createdAtEpochMs: summary.summary.computedAtEpochMs,
            expireAtEpochMs: work.expireAtEpochMs,
            effects: [
                { effectKind: 'member-state', payloadKind: 'snapshot', payload: snapshot },
                { effectKind: 'scope-directory', payloadKind: 'snapshot', payload: snapshot }
            ]
        },
        serviceId
    );
}

export function validateGroupPresenceSummaryOutboxEntries(
    computedEntries: readonly ResourceEntry[],
    input: ComputeGroupPresenceSummaryOutboxInput
): void {
    if (!jsonEquals(computedEntries, computeGroupPresenceSummaryOutboxEntries(input))) {
        throw new TypeError('Presence-summary downstream outbox entries are not canonical');
    }
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

function computeGroupPresenceTopologyOutboxEntry(
    input: ComputeGroupPresenceSummaryOutboxInput
): ResourceEntry {
    const { work, summary, snapshot, serviceId } = input;
    const identity = {
        commandId: work.commandId,
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'group-revision',
        acceptedCausalRevision: snapshot.causalRevision
    } as const;
    const computed: ComputedRtcTopologyOutbox = {
        ...identity,
        aggregateRef: work.aggregateRef,
        groupSnapshot: snapshot,
        senderId: serviceId,
        resourceId: deriveRtcTopologyEntryResourceId(identity),
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true,
        createdAtEpochMs: summary.summary.computedAtEpochMs,
        expireAtEpochMs: work.expireAtEpochMs
    };
    return computeRtcTopologyEntry(computed);
}

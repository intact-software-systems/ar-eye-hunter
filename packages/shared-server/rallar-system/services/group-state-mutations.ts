import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
} from '@shared/api/group-types.ts';
import {
    compareGroupCausalRevision,
} from '@shared/api/group-client-views.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    groupStateGroupStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey,
} from '../group-state-storage-keys.ts';
import { validateRuntimeEntryValue } from '../group-state/mutation/validate-group-mutation-read.ts';
import { admissionIdentity } from '../group-state/mutation/compute-group-presence-mutation.ts';
import {
    validateStoredGroup,
    validateStoredMember,
} from '../group-state/persistence/validate-persisted-group.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession,
    validatePresenceSummaryValue,
} from '../group-state/persistence/validate-persisted-group-presence.ts';
import {
    assertExactKeys,
    assertRequiredKeys,
    requireJsonSafe,
    requirePositiveSafeInteger,
} from '../group-state/mutation/group-state-validation-primitives.ts';
export {
    normalizePersistedGroupEvent,
    validatePersistedGroupEvent,
} from '../persisted-group-event.ts';
export {
    computeGroupPresenceSummaryEntry,
    GROUP_PRESENCE_SUMMARY_TOPIC as APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC,
    type GroupPresenceSummaryWorkData,
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
export type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationIdempotencyProbe,
    GroupMutationIdempotencyRecord,
    GroupMutationRead,
    GroupMutationReceipt,
} from '../group-state/mutation/group-mutation-contracts.ts';
export { GroupMutationRejectedError } from '../group-state/mutation/group-mutation-contracts.ts';
export { validateGroupMutationCommand } from '../group-state/mutation/group-mutation-command-validation.ts';
export {
    computeGroupMutation,
    probeGroupMutationIdempotency,
} from '../group-state/mutation/compute-group-mutation.ts';
export { validateGroupMutation } from '../group-state/mutation/validate-group-mutation.ts';
export {
    validateGroupMutationRequest,
    validateGroupPresenceMutationRequest,
} from '../group-state/mutation/group-mutation-request-validation.ts';
export {
    normalizePersistedGroup,
    normalizePersistedGroupMember,
    normalizePersistedGroupPresenceAdmission,
    normalizePersistedGroupPresenceSession,
    normalizePersistedGroupPresenceSummary,
} from '../group-state/persistence/group-state-persistence-codec.ts';
export {
    validatePersistedGroup,
    validatePersistedGroupMember,
} from '../group-state/persistence/validate-persisted-group.ts';
export {
    validatePersistedGroupPresenceAdmission,
    validatePersistedGroupPresenceSession,
    validatePersistedGroupPresenceSummary,
} from '../group-state/persistence/validate-persisted-group-presence.ts';
export { validateGroupMutationIdempotencyRecord } from '../group-state/mutation/group-mutation-result.ts';

export type GroupPresenceSummaryRead = Readonly<{
    group: RuntimeStateEntryValue<Group>;
    members: readonly RuntimeStateEntryValue<GroupMember>[];
    admissions: readonly RuntimeStateEntryValue<GroupPresenceAdmission>[];
    presenceSessions: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
    current: RuntimeStateEntryValue<GroupPresenceSummary> | null;
}>;

export type GroupPresenceSummaryComputed =
    | Readonly<{
        outcome: 'no-op';
        evaluatedAtEpochMs: number;
        summary: GroupPresenceSummary;
    }>
    | Readonly<{
        outcome: 'write';
        evaluatedAtEpochMs: number;
        operation: 'insert' | 'update';
        expectedRevision: number | null;
        summary: GroupPresenceSummary;
    }>;

export function computeGroupPresenceSummary(input: Readonly<{
    ref: GroupRef;
    read: GroupPresenceSummaryRead;
    nowEpochMs: number;
}>): GroupPresenceSummaryComputed {
    const { ref, read, nowEpochMs } = input;
    const content = deriveGroupPresenceSummaryContent(read, nowEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    if (current && (current.causalRevision.groupRevision > groupRevision ||
        current.causalRevision.groupRevision === groupRevision &&
        jsonEquals(summaryContent(current), content))) {
        return { outcome: 'no-op', evaluatedAtEpochMs: nowEpochMs, summary: current };
    }
    const summary: GroupPresenceSummary = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
        causalRevision: {
            groupRevision,
            presenceRevision:
                (current?.causalRevision.presenceRevision ?? 0) + 1,
        },
        ...content,
        computedAtEpochMs: nowEpochMs,
    };
    return {
        outcome: 'write',
        evaluatedAtEpochMs: nowEpochMs,
        operation: read.current ? 'update' : 'insert',
        expectedRevision: read.current?.entry.revision ?? null,
        summary,
    };
}

export function validateGroupPresenceSummary(input: Readonly<{
    ref: GroupRef;
    read: GroupPresenceSummaryRead;
    computed: GroupPresenceSummaryComputed;
}>): void {
    const { ref, read, computed } = input;
    requireJsonSafe(read, 'Group presence summary read');
    requireJsonSafe(computed, 'Group presence summary computed result');
    assertExactKeys(read as unknown as Record<string, unknown>, [
        'group', 'members', 'admissions', 'presenceSessions', 'current',
    ], 'Group presence summary read');
    assertRequiredKeys(read as unknown as Record<string, unknown>, [
        'group', 'members', 'admissions', 'presenceSessions', 'current',
    ], 'Group presence summary read');
    validateRuntimeEntryValue(
        read.group,
        'Stored summary group',
        groupStateGroupStorageKey(ref),
    );
    validateStoredGroup(read.group.value, ref);
    validateGroupPresenceSummaryReadCollections(ref, read);
    if (read.current) {
        validateRuntimeEntryValue(
            read.current,
            'Stored current presence summary',
            groupStatePresenceSummaryStorageKey(ref),
        );
        validatePresenceSummaryValue(read.current.value, ref);
    }
    const summary = computed.summary;
    validatePresenceSummaryValue(summary, ref);
    requirePositiveSafeInteger(computed.evaluatedAtEpochMs,
        'Group presence summary evaluatedAtEpochMs');
    const expectedContent = deriveGroupPresenceSummaryContent(read,
        computed.evaluatedAtEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    const expectedNoOp = current !== undefined && (
        current.causalRevision.groupRevision > groupRevision ||
        current.causalRevision.groupRevision === groupRevision &&
        jsonEquals(summaryContent(current), expectedContent));
    const shape = computed as unknown as Record<string, unknown>;
    if (computed.outcome === 'no-op') {
        assertExactKeys(shape, ['outcome', 'evaluatedAtEpochMs', 'summary'],
            'Group presence summary computed result');
        if (!expectedNoOp || !current || !jsonEquals(summary, current)) {
            throw new TypeError(
                'Group presence summary no-op differs from current canonical candidate',
            );
        }
    } else {
        assertExactKeys(shape,
            ['outcome', 'evaluatedAtEpochMs', 'operation', 'expectedRevision', 'summary'],
            'Group presence summary computed result');
        const expectedSummary: GroupPresenceSummary = {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId,
            causalRevision: {
                groupRevision,
                presenceRevision:
                    (current?.causalRevision.presenceRevision ?? 0) + 1,
            },
            ...expectedContent,
            computedAtEpochMs: computed.evaluatedAtEpochMs,
        };
        if (expectedNoOp ||
            computed.operation !== (read.current ? 'update' : 'insert') ||
            computed.expectedRevision !== (read.current?.entry.revision ?? null) ||
            !jsonEquals(summary, expectedSummary)) {
            throw new TypeError(
                'Group presence summary write differs from canonical predecessor projection',
            );
        }
    }
    if (read.current) {
        const comparison = compareGroupCausalRevision(
            summary.causalRevision,
            read.current.value.causalRevision,
        );
        if (computed.outcome === 'write' && comparison !== 'dominates') {
            throw new TypeError('Group presence summary write must advance its causal tuple');
        }
        if (
            comparison === 'equal' &&
            !jsonEquals(summaryContent(summary), summaryContent(read.current.value))
        ) {
            throw new TypeError('Equal group presence summary tuple has different content');
        }
    }
}

function deriveGroupPresenceSummaryContent(
    read: GroupPresenceSummaryRead,
    nowEpochMs: number,
): ReturnType<typeof summaryContent> {
    const groupActive = read.group.value.status === 'active' &&
        (read.group.value.expiresAtEpochMs === null ||
            read.group.value.expiresAtEpochMs > nowEpochMs);
    const activeMemberIds = new Set(read.members
        .map((stored) => stored.value)
        .filter((member) => member.status === 'active')
        .map((member) => member.principalId));
    const admitted = new Set(read.admissions.flatMap(({ value: admission }) =>
        admission.admittedSessions.map((session) =>
            admissionIdentity(admission.principalId, session)
        )
    ));
    const activeSessions = (groupActive
        ? read.presenceSessions.map(({ value }) => value).filter((session) =>
            activeMemberIds.has(session.principalId) &&
            admitted.has(admissionIdentity(session.principalId, session)) &&
            session.disconnectedAtEpochMs === null &&
            session.expiresAtEpochMs > nowEpochMs
        )
        : [])
        .toSorted((left, right) =>
            left.sessionId.localeCompare(right.sessionId) ||
            left.generationVersion - right.generationVersion
        );
    const activePrincipalIds = [...new Set(
        activeSessions.map((session) => session.principalId),
    )].toSorted();
    return {
        activePrincipalIds,
        activeSessionIds: activeSessions.map((session) => session.sessionId),
        activeSessions,
        activePrincipalCount: activePrincipalIds.length,
        activeSessionCount: activeSessions.length,
    };
}

function validateGroupPresenceSummaryReadCollections(
    ref: GroupRef,
    read: GroupPresenceSummaryRead,
): void {
    for (const [label, values] of [
        ['members', read.members],
        ['admissions', read.admissions],
        ['presence sessions', read.presenceSessions],
    ] as const) {
        if (!Array.isArray(values)) {
            throw new TypeError(`Group presence summary ${label} must be an array`);
        }
    }
    const memberIds = new Set<string>();
    for (const stored of read.members) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary member',
            groupStateMemberStorageKey({
                ...ref,
                principalId: stored.value.principalId,
            }),
        );
        validateStoredMember(stored.value, ref, 'Stored summary member');
        if (memberIds.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary member principal is duplicated');
        }
        memberIds.add(stored.value.principalId);
    }
    const activeMembers = read.members.map(({ value }) => value)
        .filter((member) => member.status === 'active');
    const activeOwners = activeMembers.filter((member) => member.role === 'owner');
    if (read.group.value.activeMemberCount !== activeMembers.length ||
        activeOwners.length !== 1 ||
        activeOwners[0]?.principalId !== read.group.value.ownerPrincipalId) {
        throw new TypeError('Group presence summary roster facts are inconsistent');
    }

    const admissionPrincipals = new Set<string>();
    const admittedSessionOwners = new Map<string, string>();
    for (const stored of read.admissions) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary admission',
            groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: stored.value.principalId,
            }),
        );
        validatePresenceAdmission(stored.value, ref);
        if (admissionPrincipals.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary admission principal is duplicated');
        }
        admissionPrincipals.add(stored.value.principalId);
        for (const session of stored.value.admittedSessions) {
            const existing = admittedSessionOwners.get(session.sessionId);
            if (existing !== undefined && existing !== stored.value.principalId) {
                throw new TypeError('Group presence summary session has multiple principals');
            }
            admittedSessionOwners.set(session.sessionId, stored.value.principalId);
        }
    }

    const sessionsById = new Map<string, GroupPresenceSession>();
    for (const stored of read.presenceSessions) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary presence session',
            groupStatePresenceSessionStorageKey({
                ...ref,
                sessionId: stored.value.sessionId,
            }),
        );
        validatePresenceSession(stored.value, ref, 'Stored summary presence session');
        if (sessionsById.has(stored.value.sessionId)) {
            throw new TypeError('Group presence summary sessionId is duplicated');
        }
        sessionsById.set(stored.value.sessionId, stored.value);
    }
    for (const stored of read.admissions) {
        for (const admitted of stored.value.admittedSessions) {
            const session = sessionsById.get(admitted.sessionId);
            if (!session) continue;
            if (session.principalId !== stored.value.principalId ||
                session.generationId !== admitted.generationId ||
                session.generationVersion !== admitted.generationVersion ||
                session.connectedAtEpochMs !== admitted.connectedAtEpochMs) {
                throw new TypeError(
                    'Group presence summary admission differs from stored generation',
                );
            }
        }
    }
}




function summaryContent(summary: GroupPresenceSummary): Readonly<{
    activePrincipalIds: readonly string[];
    activeSessionIds: readonly string[];
    activeSessions: readonly GroupPresenceSession[];
    activePrincipalCount: number;
    activeSessionCount: number;
}> {
    return {
        activePrincipalIds: summary.activePrincipalIds,
        activeSessionIds: summary.activeSessionIds,
        activeSessions: summary.activeSessions,
        activePrincipalCount: summary.activePrincipalCount,
        activeSessionCount: summary.activeSessionCount,
    };
}

export { compareGroupCausalRevision };

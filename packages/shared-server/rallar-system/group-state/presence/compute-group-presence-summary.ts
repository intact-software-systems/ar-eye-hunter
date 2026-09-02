import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../group-state-validation-issues.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { isValidRuntimeStateUpsertExpectedRevision } from '../../../runtime-state/runtime-state-repository.ts';
import {
    validateExactKeys,
    validateJsonSafe,
    validatePositiveSafeInteger,
    validateRequiredKeys
} from '../group-state-validation-issues.ts';
import { presenceAdmissionIdentity } from '../mutation/presence/compute-group-presence-admission.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStatePresenceSummaryStorageKey } from '../persistence/presence/group-presence-storage-keys.ts';
import { validateGroupStateRuntimeEntry } from '../persistence/validate-group-state-runtime-entry.ts';
import { validatePresenceSummaryValue } from '../persistence/validate-persisted-group-presence.ts';
import { validateStoredGroup } from '../persistence/validate-persisted-group.ts';
import { validateGroupPresenceSummaryReadCollections } from './validate-group-presence-summary-read-collections.ts';

export interface GroupPresenceSummaryRead {
    readonly group: RuntimeStateEntryValue<Group>;
    readonly members: readonly RuntimeStateEntryValue<GroupMember>[];
    readonly admissions: readonly RuntimeStateEntryValue<GroupPresenceAdmission>[];
    readonly presenceSessions: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
    readonly current: RuntimeStateEntryValue<GroupPresenceSummary> | null;
}

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

interface ComputeGroupPresenceSummaryInput {
    readonly ref: GroupRef;
    readonly read: GroupPresenceSummaryRead;
    readonly nowEpochMs: number;
}

interface ValidateGroupPresenceSummaryInput {
    readonly ref: GroupRef;
    readonly read: GroupPresenceSummaryRead;
    readonly computed: GroupPresenceSummaryComputed;
}

interface GroupPresenceSummaryValidation {
    readonly ref: GroupRef;
    readonly read: GroupPresenceSummaryRead;
    readonly computed: GroupPresenceSummaryComputed;
    readonly expectedContent: GroupPresenceSummaryContent;
    readonly groupRevision: number;
    readonly current: GroupPresenceSummary | undefined;
    readonly expectedNoOp: boolean;
}

interface GroupPresenceSummaryContent {
    readonly activePrincipalIds: readonly string[];
    readonly activeSessionIds: readonly string[];
    readonly activeSessions: readonly GroupPresenceSession[];
    readonly activePrincipalCount: number;
    readonly activeSessionCount: number;
}

export function computeGroupPresenceSummary(
    input: ComputeGroupPresenceSummaryInput
): GroupPresenceSummaryComputed {
    const { ref, read, nowEpochMs } = input;
    const content = computeGroupPresenceSummaryContent(read, nowEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    if (
        current &&
        (current.causalRevision.groupRevision > groupRevision ||
            (current.causalRevision.groupRevision === groupRevision &&
                jsonEquals(
                    toComparableSummaryContent(toGroupPresenceSummaryContent(current)),
                    toComparableSummaryContent(content)
                )))
    ) {
        return { outcome: 'no-op', evaluatedAtEpochMs: nowEpochMs, summary: current };
    }
    const summary: GroupPresenceSummary = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
        causalRevision: {
            groupRevision,
            presenceRevision: (current?.causalRevision.presenceRevision ?? 0) + 1
        },
        ...content,
        computedAtEpochMs: nowEpochMs
    };
    return {
        outcome: 'write',
        evaluatedAtEpochMs: nowEpochMs,
        operation: read.current ? 'update' : 'insert',
        expectedRevision: read.current?.entry.revision ?? null,
        summary
    };
}

export function validateGroupPresenceSummary(
    input: ValidateGroupPresenceSummaryInput
): readonly GroupStateValidationIssue[] {
    const { ref, read, computed } = input;
    const issues = [...validateGroupPresenceSummaryRead(ref, read)];
    issues.push(...validateJsonSafe(computed, 'Group presence summary computed result'));
    if (issues.length === 0) {
        issues.push(...validateGroupPresenceSummaryCandidate(input));
    }
    return issues;
}

export function validateGroupPresenceSummaryRead(
    ref: GroupRef,
    read: GroupPresenceSummaryRead
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!isGroupStateRecord(read)) {
        return [toGroupStateValidationIssue('presenceSummary.read', 'Group presence summary read must be an object')];
    }
    issues.push(...validateJsonSafe(read, 'Group presence summary read'));
    issues.push(...validateExactKeys(
        read,
        ['group', 'members', 'admissions', 'presenceSessions', 'current'],
        'Group presence summary read'
    ));
    issues.push(...validateRequiredKeys(
        read,
        ['group', 'members', 'admissions', 'presenceSessions', 'current'],
        'Group presence summary read'
    ));
    issues.push(...validateGroupStateRuntimeEntry(
        read.group,
        'Stored summary group',
        groupStateGroupStorageKey(ref)
    ));
    issues.push(...validateStoredGroup(read.group?.value, ref));
    issues.push(...validateGroupPresenceSummaryReadCollections(ref, read));
    if (read.current) {
        issues.push(...validateGroupStateRuntimeEntry(
            read.current,
            'Stored current presence summary',
            groupStatePresenceSummaryStorageKey(ref)
        ));
        issues.push(...validatePresenceSummaryValue(read.current.value, ref));
    }
    return issues;
}

export function validateGroupPresenceSummaryCandidate(
    input: ValidateGroupPresenceSummaryInput
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const { ref, read, computed } = input;
    if (!isGroupStateRecord(computed)) {
        return [
            toGroupStateValidationIssue('presenceSummary.computed', 'Group presence summary computed must be an object')
        ];
    }
    issues.push(...validatePresenceSummaryValue(computed.summary, ref));
    issues.push(...validatePositiveSafeInteger(
        computed.evaluatedAtEpochMs,
        'Group presence summary evaluatedAtEpochMs'
    ));
    if (issues.length > 0) {
        return issues;
    }
    const expectedContent = computeGroupPresenceSummaryContent(read, computed.evaluatedAtEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    const expectedNoOp = current !== undefined &&
        (current.causalRevision.groupRevision > groupRevision ||
            (current.causalRevision.groupRevision === groupRevision &&
                jsonEquals(
                    toComparableSummaryContent(toGroupPresenceSummaryContent(current)),
                    toComparableSummaryContent(expectedContent)
                )));
    const validation = {
        ref,
        read,
        computed,
        expectedContent,
        groupRevision,
        current,
        expectedNoOp
    };
    issues.push(...validateGroupPresenceSummaryOutcome(validation));
    issues.push(...validateGroupPresenceSummaryCausalRevision(validation));
    return issues;
}

function validateGroupPresenceSummaryOutcome(
    validation: GroupPresenceSummaryValidation
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const { ref, read, computed, expectedContent, groupRevision, current, expectedNoOp } = validation;
    if (computed.outcome === 'no-op') {
        issues.push(...validateExactKeys(
            computed,
            ['outcome', 'evaluatedAtEpochMs', 'summary'],
            'Group presence summary computed result'
        ));
        if (!expectedNoOp || !current || !jsonEquals(computed.summary, current)) {
            issues.push(
                toGroupStateValidationIssue(
                    'computed.summary.outcome',
                    'Group presence summary no-op differs from current canonical candidate'
                )
            );
        }
        return issues;
    }
    issues.push(...validateExactKeys(
        computed,
        ['outcome', 'evaluatedAtEpochMs', 'operation', 'expectedRevision', 'summary'],
        'Group presence summary computed result'
    ));
    if (computed.operation === 'update' && !isValidRuntimeStateUpsertExpectedRevision(computed.expectedRevision)) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.summary.outcome',
                'Group presence summary update expectedRevision must be incrementable'
            )
        );
    }
    const expectedSummary: GroupPresenceSummary = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
        causalRevision: {
            groupRevision,
            presenceRevision: (current?.causalRevision.presenceRevision ?? 0) + 1
        },
        ...expectedContent,
        computedAtEpochMs: computed.evaluatedAtEpochMs
    };
    if (
        expectedNoOp ||
        computed.operation !== (read.current ? 'update' : 'insert') ||
        computed.expectedRevision !== (read.current?.entry.revision ?? null) ||
        !jsonEquals(computed.summary, expectedSummary)
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.summary.outcome',
                'Group presence summary write differs from canonical predecessor projection'
            )
        );
    }
    return issues;
}

function validateGroupPresenceSummaryCausalRevision(
    validation: GroupPresenceSummaryValidation
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!validation.read.current) {
        return issues;
    }
    const comparison = compareGroupCausalRevision(
        validation.computed.summary.causalRevision,
        validation.read.current.value.causalRevision
    );
    if (validation.computed.outcome === 'write' && comparison !== 'dominates') {
        issues.push(
            toGroupStateValidationIssue(
                'computed.summary.causalRevision',
                'Group presence summary write must advance its causal tuple'
            )
        );
    }
    if (
        comparison === 'equal' &&
        !jsonEquals(
            toComparableSummaryContent(toGroupPresenceSummaryContent(validation.computed.summary)),
            toComparableSummaryContent(toGroupPresenceSummaryContent(validation.read.current.value))
        )
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.summary.causalRevision',
                'Equal group presence summary tuple has different content'
            )
        );
    }
    return issues;
}

function computeGroupPresenceSummaryContent(
    read: GroupPresenceSummaryRead,
    nowEpochMs: number
): GroupPresenceSummaryContent {
    const groupActive = read.group.value.status === 'active' &&
        (read.group.value.expiresAtEpochMs === null || read.group.value.expiresAtEpochMs > nowEpochMs);
    const activeMemberIds = new Set(
        read.members
            .map((stored) => stored.value)
            .filter((member) => member.status === 'active')
            .map((member) => member.principalId)
    );
    const admitted = new Set(
        read.admissions.flatMap(({ value: admission }) =>
            admission.admittedSessions.map((session) => presenceAdmissionIdentity(admission.principalId, session))
        )
    );
    const activeSessions = (
        groupActive
            ? read.presenceSessions
                .map(({ value }) => value)
                .filter(
                    (session) =>
                        activeMemberIds.has(session.principalId) &&
                        admitted.has(presenceAdmissionIdentity(session.principalId, session)) &&
                        session.disconnectedAtEpochMs === null &&
                        session.expiresAtEpochMs > nowEpochMs
                )
            : []
    ).toSorted(
        (left, right) =>
            left.sessionId.localeCompare(right.sessionId) ||
            left.generationVersion - right.generationVersion
    );
    const activePrincipalIds = [
        ...new Set(activeSessions.map((session) => session.principalId))
    ].toSorted();
    return {
        activePrincipalIds,
        activeSessionIds: activeSessions.map((session) => session.sessionId),
        activeSessions,
        activePrincipalCount: activePrincipalIds.length,
        activeSessionCount: activeSessions.length
    };
}

function toGroupPresenceSummaryContent(summary: GroupPresenceSummary): GroupPresenceSummaryContent {
    return {
        activePrincipalIds: summary.activePrincipalIds,
        activeSessionIds: summary.activeSessionIds,
        activeSessions: summary.activeSessions,
        activePrincipalCount: summary.activePrincipalCount,
        activeSessionCount: summary.activeSessionCount
    };
}

/**
 * Under damped formation the session lease fields are liveness, not content:
 * a renewed lease over an identical session set must compare equal so a pure
 * renewal never advances presenceRevision.
 */
function toComparableSummaryContent(
    content: GroupPresenceSummaryContent
): GroupPresenceSummaryContent {
    return {
        ...content,
        activeSessions: content.activeSessions.map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs: 0,
            expiresAtEpochMs: 0
        }))
    };
}

export { compareGroupCausalRevision };

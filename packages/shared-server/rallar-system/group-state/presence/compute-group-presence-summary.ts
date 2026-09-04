import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import type { ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import { presenceAdmissionIdentity } from '../mutation/presence/compute-group-presence-admission.ts';

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
        operation: 'insert';
        expectedRevision: null;
        summary: GroupPresenceSummary;
    }>
    | Readonly<{
        outcome: 'write';
        evaluatedAtEpochMs: number;
        operation: 'update';
        expectedRevision: number;
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
    readonly nowEpochMs: number;
    readonly computed: GroupPresenceSummaryComputed;
}

export function computeGroupPresenceSummary(
    input: ComputeGroupPresenceSummaryInput
): GroupPresenceSummaryComputed {
    const { ref, read, nowEpochMs } = input;
    const content = deriveGroupPresenceSummaryContent(read, nowEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    if (
        current &&
        (current.causalRevision.groupRevision > groupRevision ||
            (current.causalRevision.groupRevision === groupRevision &&
                jsonEquals(
                    toComparableSummaryContent(summaryContent(current)),
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
    return read.current
        ? {
            outcome: 'write',
            evaluatedAtEpochMs: nowEpochMs,
            operation: 'update',
            expectedRevision: read.current.entry.revision,
            summary
        }
        : {
            outcome: 'write',
            evaluatedAtEpochMs: nowEpochMs,
            operation: 'insert',
            expectedRevision: null,
            summary
        };
}

export function validateGroupPresenceSummary(
    input: ValidateGroupPresenceSummaryInput
): readonly ComputedDataValidationIssue[] {
    const expected = computeGroupPresenceSummary({
        ref: input.ref,
        read: input.read,
        nowEpochMs: input.nowEpochMs
    });
    return validateComputedProjection(expected, input.computed, 'computed');
}

function deriveGroupPresenceSummaryContent(
    read: GroupPresenceSummaryRead,
    nowEpochMs: number
): ReturnType<typeof summaryContent> {
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
        activeSessionCount: summary.activeSessionCount
    };
}

/**
 * Under damped formation the session lease fields are liveness, not content:
 * a renewed lease over an identical session set must compare equal so a pure
 * renewal never advances presenceRevision.
 */
function toComparableSummaryContent(
    content: ReturnType<typeof summaryContent>
): ReturnType<typeof summaryContent> {
    return {
        ...content,
        activeSessions: content.activeSessions.map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs: 0,
            expiresAtEpochMs: 0
        }))
    };
}

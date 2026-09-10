import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import { arrayEquals } from '@shared/repository/state-utils.ts';
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
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    if (current && current.causalRevision.groupRevision > groupRevision) {
        return { outcome: 'no-op', evaluatedAtEpochMs: nowEpochMs, summary: current };
    }

    const content = deriveGroupPresenceSummaryContent(read, nowEpochMs);
    const currentContentMatches = current !== undefined &&
        groupPresenceSummaryContentEquals(current, content);
    if (
        current &&
        current.causalRevision.groupRevision === groupRevision &&
        currentContentMatches
    ) {
        return { outcome: 'no-op', evaluatedAtEpochMs: nowEpochMs, summary: current };
    }
    const summary: GroupPresenceSummary = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
        causalRevision: {
            groupRevision,
            // Lifecycle and configuration writes advance the group revision;
            // presence advances only when its canonical derived content changes.
            presenceRevision: current !== undefined && currentContentMatches
                ? current.causalRevision.presenceRevision
                : (current?.causalRevision.presenceRevision ?? 0) + 1
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

/**
 * Under damped formation the session lease fields are liveness, not content:
 * a renewed lease over an identical session set must compare equal so a pure
 * renewal never advances presenceRevision.
 */
function groupPresenceSummaryContentEquals(
    current: GroupPresenceSummary,
    content: GroupPresenceSummaryContent
): boolean {
    return current.activePrincipalCount === content.activePrincipalCount &&
        current.activeSessionCount === content.activeSessionCount &&
        arrayEquals(current.activePrincipalIds, content.activePrincipalIds) &&
        arrayEquals(current.activeSessionIds, content.activeSessionIds) &&
        current.activeSessions.length === content.activeSessions.length &&
        current.activeSessions.every((session, index) =>
            groupPresenceSessionContentEquals(session, content.activeSessions[index]!)
        );
}

function groupPresenceSessionContentEquals(
    current: GroupPresenceSession,
    content: GroupPresenceSession
): boolean {
    return current.applicationId === content.applicationId &&
        current.workspaceId === content.workspaceId &&
        current.groupId === content.groupId &&
        current.sessionId === content.sessionId &&
        current.principalId === content.principalId &&
        current.generationId === content.generationId &&
        current.generationVersion === content.generationVersion &&
        current.connectedAtEpochMs === content.connectedAtEpochMs &&
        current.status === content.status &&
        current.disconnectedAtEpochMs === content.disconnectedAtEpochMs &&
        current.disconnectReason === content.disconnectReason;
}

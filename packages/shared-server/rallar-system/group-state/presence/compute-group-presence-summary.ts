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
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import {
    assertExactKeys,
    assertRequiredKeys,
    requireJsonSafe,
    requirePositiveSafeInteger
} from '../group-state-validation-primitives.ts';
import { presenceAdmissionIdentity } from '../mutation/presence/compute-group-presence-admission.ts';
import { validateRuntimeEntryValue } from '../mutation/state-validation/validate-group-mutation-read.ts';
import {
    groupStateGroupStorageKey,
    groupStatePresenceSummaryStorageKey
} from '../persistence/group-state-storage-keys.ts';
import { validatePresenceSummaryValue } from '../persistence/validate-persisted-group-presence.ts';
import { validateStoredGroup } from '../persistence/validate-persisted-group.ts';
import { validateGroupPresenceSummaryReadCollections } from './validate-group-presence-summary-read-collections.ts';

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

interface GroupPresenceSummaryValidation {
    readonly ref: GroupRef;
    readonly read: GroupPresenceSummaryRead;
    readonly computed: GroupPresenceSummaryComputed;
    readonly expectedContent: ReturnType<typeof summaryContent>;
    readonly groupRevision: number;
    readonly current: GroupPresenceSummary | undefined;
    readonly expectedNoOp: boolean;
    readonly formationDamping: 'damped' | 'legacy';
}

export function computeGroupPresenceSummary(
    input: Readonly<{
        ref: GroupRef;
        read: GroupPresenceSummaryRead;
        nowEpochMs: number;
        formationDamping: 'damped' | 'legacy';
    }>
): GroupPresenceSummaryComputed {
    const { ref, read, nowEpochMs, formationDamping } = input;
    const content = deriveGroupPresenceSummaryContent(read, nowEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    if (
        current &&
        (current.causalRevision.groupRevision > groupRevision ||
            (current.causalRevision.groupRevision === groupRevision &&
                jsonEquals(
                    toComparableSummaryContent(summaryContent(current), formationDamping),
                    toComparableSummaryContent(content, formationDamping)
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
    input: Readonly<{
        ref: GroupRef;
        read: GroupPresenceSummaryRead;
        computed: GroupPresenceSummaryComputed;
        formationDamping: 'damped' | 'legacy';
    }>
): void {
    const { ref, read, computed } = input;
    requireJsonSafe(read, 'Group presence summary read');
    requireJsonSafe(computed, 'Group presence summary computed result');
    assertExactKeys(
        read,
        ['group', 'members', 'admissions', 'presenceSessions', 'current'],
        'Group presence summary read'
    );
    assertRequiredKeys(
        read,
        ['group', 'members', 'admissions', 'presenceSessions', 'current'],
        'Group presence summary read'
    );
    validateRuntimeEntryValue(read.group, 'Stored summary group', groupStateGroupStorageKey(ref));
    validateStoredGroup(read.group.value, ref);
    validateGroupPresenceSummaryReadCollections(ref, read);
    if (read.current) {
        validateRuntimeEntryValue(
            read.current,
            'Stored current presence summary',
            groupStatePresenceSummaryStorageKey(ref)
        );
        validatePresenceSummaryValue(read.current.value, ref);
    }
    validateGroupPresenceSummaryCandidate(input);
}

function validateGroupPresenceSummaryCandidate(
    input: Readonly<{
        ref: GroupRef;
        read: GroupPresenceSummaryRead;
        computed: GroupPresenceSummaryComputed;
        formationDamping: 'damped' | 'legacy';
    }>
): void {
    const { ref, read, computed, formationDamping } = input;
    validatePresenceSummaryValue(computed.summary, ref);
    requirePositiveSafeInteger(
        computed.evaluatedAtEpochMs,
        'Group presence summary evaluatedAtEpochMs'
    );
    const expectedContent = deriveGroupPresenceSummaryContent(read, computed.evaluatedAtEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    const expectedNoOp = current !== undefined &&
        (current.causalRevision.groupRevision > groupRevision ||
            (current.causalRevision.groupRevision === groupRevision &&
                jsonEquals(
                    toComparableSummaryContent(summaryContent(current), formationDamping),
                    toComparableSummaryContent(expectedContent, formationDamping)
                )));
    const validation = {
        ref,
        read,
        computed,
        expectedContent,
        groupRevision,
        current,
        expectedNoOp,
        formationDamping
    };
    validateGroupPresenceSummaryOutcome(validation);
    validateGroupPresenceSummaryCausalRevision(validation);
}

function validateGroupPresenceSummaryOutcome(validation: GroupPresenceSummaryValidation): void {
    const { ref, read, computed, expectedContent, groupRevision, current, expectedNoOp } = validation;
    if (computed.outcome === 'no-op') {
        assertExactKeys(
            computed,
            ['outcome', 'evaluatedAtEpochMs', 'summary'],
            'Group presence summary computed result'
        );
        if (!expectedNoOp || !current || !jsonEquals(computed.summary, current)) {
            throw new TypeError('Group presence summary no-op differs from current canonical candidate');
        }
        return;
    }
    assertExactKeys(
        computed,
        ['outcome', 'evaluatedAtEpochMs', 'operation', 'expectedRevision', 'summary'],
        'Group presence summary computed result'
    );
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
        throw new TypeError(
            'Group presence summary write differs from canonical predecessor projection'
        );
    }
}

function validateGroupPresenceSummaryCausalRevision(
    validation: GroupPresenceSummaryValidation
): void {
    if (!validation.read.current) {
        return;
    }
    const comparison = compareGroupCausalRevision(
        validation.computed.summary.causalRevision,
        validation.read.current.value.causalRevision
    );
    if (validation.computed.outcome === 'write' && comparison !== 'dominates') {
        throw new TypeError('Group presence summary write must advance its causal tuple');
    }
    if (
        comparison === 'equal' &&
        !jsonEquals(
            toComparableSummaryContent(
                summaryContent(validation.computed.summary),
                validation.formationDamping
            ),
            toComparableSummaryContent(
                summaryContent(validation.read.current.value),
                validation.formationDamping
            )
        )
    ) {
        throw new TypeError('Equal group presence summary tuple has different content');
    }
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
 * renewal never advances presenceRevision. Legacy keeps full-session content
 * so heartbeats keep rewriting the summary exactly as before.
 */
function toComparableSummaryContent(
    content: ReturnType<typeof summaryContent>,
    formationDamping: 'damped' | 'legacy'
): ReturnType<typeof summaryContent> {
    if (formationDamping === 'legacy') {
        return content;
    }
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

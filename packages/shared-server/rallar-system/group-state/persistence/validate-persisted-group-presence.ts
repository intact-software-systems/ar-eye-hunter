import type { GroupPresenceAdmission, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../group-state-validation-issues.ts';

import {
    validateExactKeys,
    validateNonEmptyString,
    validateNonNegativeSafeInteger,
    validateNullableNonEmptyString,
    validateNullablePositiveSafeInteger,
    validateOneOf,
    validatePositiveSafeInteger,
    validateRecord,
    validateRequiredKeys
} from '../group-state-validation-issues.ts';

import { validateCausalRevision, validateScopedRecord } from './validate-persisted-group.ts';

const PRESENCE_SESSION_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'sessionId',
    'principalId',
    'generationId',
    'generationVersion',
    'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
    'disconnectedAtEpochMs',
    'disconnectReason',
    'status'
] as const;

const PRESENCE_SUMMARY_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'causalRevision',
    'activePrincipalIds',
    'activeSessionIds',
    'activeSessions',
    'activePrincipalCount',
    'activeSessionCount',
    'computedAtEpochMs'
] as const;

const PRESENCE_ADMISSION_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'principalId',
    'admittedSessions',
    'updatedAtEpochMs'
] as const;

const ADMITTED_SESSION_KEYS = [
    'sessionId',
    'generationId',
    'generationVersion',
    'connectedAtEpochMs'
] as const;

export function validatePresenceSession(
    session: unknown,
    ref: GroupRef,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const value = session;
    if (!isGroupStateRecord(value)) {
        return [...issues, ...validateRecord(value, `${label} value`)];
    }
    issues.push(...validateExactKeys(value, PRESENCE_SESSION_KEYS, `${label} value`));
    issues.push(...validateRequiredKeys(value, PRESENCE_SESSION_KEYS, `${label} value`));
    issues.push(...validateScopedRecord(value, ref, label));
    issues.push(...validateNonEmptyString(value.sessionId, `${label} sessionId`));
    issues.push(...validateNonEmptyString(value.principalId, `${label} principalId`));
    issues.push(...validateNonEmptyString(value.generationId, `${label} generationId`));
    issues.push(...validatePositiveSafeInteger(value.connectedAtEpochMs, 'Stored presence connectedAtEpochMs'));
    issues.push(...validatePositiveSafeInteger(value.generationVersion, 'Stored presence generationVersion'));
    if (value.generationVersion !== value.connectedAtEpochMs) {
        issues.push(toGroupStateValidationIssue(label, 'Stored presence generation order is ambiguous'));
    }
    issues.push(...validatePositiveSafeInteger(value.lastHeartbeatAtEpochMs, `${label} lastHeartbeatAtEpochMs`));
    issues.push(...validatePositiveSafeInteger(value.expiresAtEpochMs, `${label} expiresAtEpochMs`));
    if (
        (typeof value.lastHeartbeatAtEpochMs === 'number' && typeof value.connectedAtEpochMs === 'number' &&
            value.lastHeartbeatAtEpochMs < value.connectedAtEpochMs) ||
        (typeof value.expiresAtEpochMs === 'number' && typeof value.lastHeartbeatAtEpochMs === 'number' &&
            value.expiresAtEpochMs < value.lastHeartbeatAtEpochMs)
    ) {
        issues.push(toGroupStateValidationIssue(label, `${label} timestamps are causally inconsistent`));
    }
    issues.push(...validateOneOf(value.status, ['active', 'disconnected'], `${label} status`));
    issues.push(...validateNullablePositiveSafeInteger(value.disconnectedAtEpochMs, `${label} disconnectedAtEpochMs`));
    issues.push(...validateNullableNonEmptyString(value.disconnectReason, `${label} disconnectReason`));
    if (
        typeof value.disconnectedAtEpochMs === 'number' && typeof value.lastHeartbeatAtEpochMs === 'number' &&
        value.disconnectedAtEpochMs < value.lastHeartbeatAtEpochMs
    ) {
        issues.push(toGroupStateValidationIssue(label, `${label} disconnect predates heartbeat`));
    }
    if (
        value.status === 'active' &&
        (value.disconnectedAtEpochMs !== null || value.disconnectReason !== null)
    ) {
        issues.push(toGroupStateValidationIssue(label, `${label} active disconnect fields must be null`));
    }
    if (
        value.status === 'disconnected' &&
        (value.disconnectedAtEpochMs === null || value.disconnectReason === null)
    ) {
        issues.push(toGroupStateValidationIssue(label, `${label} disconnect lifecycle fields differ`));
    }
    return issues;
}

export function validatePresenceSummaryValue(
    summary: unknown,
    ref: GroupRef
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const value = summary;
    if (!isGroupStateRecord(value)) {
        return [...issues, ...validateRecord(value, 'Stored presence summary value')];
    }
    issues.push(...validateExactKeys(value, PRESENCE_SUMMARY_KEYS, 'Stored presence summary value'));
    issues.push(...validateRequiredKeys(value, PRESENCE_SUMMARY_KEYS, 'Stored presence summary value'));
    issues.push(...validateScopedRecord(value, ref, 'Stored presence summary'));
    issues.push(...validateCausalRevision(value.causalRevision, 'Stored presence summary'));
    if (
        !Array.isArray(value.activePrincipalIds) ||
        !Array.isArray(value.activeSessionIds) ||
        !Array.isArray(value.activeSessions)
    ) {
        issues.push(
            toGroupStateValidationIssue('Stored presence summary', 'Stored presence summary collections must be arrays')
        );
    }
    for (const principalId of Array.isArray(value.activePrincipalIds) ? value.activePrincipalIds : []) {
        issues.push(...validateNonEmptyString(principalId, 'Stored presence summary principalId'));
    }
    for (const sessionId of Array.isArray(value.activeSessionIds) ? value.activeSessionIds : []) {
        issues.push(...validateNonEmptyString(sessionId, 'Stored presence summary sessionId'));
    }
    const activeSessions: GroupPresenceSession[] = [];
    for (const session of Array.isArray(value.activeSessions) ? value.activeSessions : []) {
        const sessionIssues = validatePresenceSession(session, ref, 'Stored presence summary session');
        issues.push(...sessionIssues);
        if (sessionIssues.length === 0) {
            activeSessions.push(session as GroupPresenceSession);
        }
    }
    issues.push(...validateNonNegativeSafeInteger(
        value.activePrincipalCount,
        'Stored presence summary activePrincipalCount'
    ));
    issues.push(...validateNonNegativeSafeInteger(
        value.activeSessionCount,
        'Stored presence summary activeSessionCount'
    ));
    issues.push(...validatePositiveSafeInteger(value.computedAtEpochMs, 'Stored presence summary computedAtEpochMs'));
    issues.push(...validatePresenceSummaryAggregates(value, activeSessions));
    return issues;
}

function validatePresenceSummaryAggregates(
    value: Record<string, unknown>,
    activeSessions: readonly GroupPresenceSession[]
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const canonicalSessions = activeSessions.toSorted(
        (left, right) =>
            left.sessionId.localeCompare(right.sessionId) ||
            left.generationVersion - right.generationVersion
    );
    const canonicalPrincipals = [
        ...new Set(activeSessions.map((session) => session.principalId))
    ].toSorted();
    if (
        value.activePrincipalCount !==
            (Array.isArray(value.activePrincipalIds) ? value.activePrincipalIds.length : undefined) ||
        value.activeSessionCount !==
            (Array.isArray(value.activeSessionIds) ? value.activeSessionIds.length : undefined) ||
        value.activeSessionCount !== activeSessions.length ||
        !jsonEquals(value.activePrincipalIds, canonicalPrincipals) ||
        !jsonEquals(activeSessions, canonicalSessions) ||
        !jsonEquals(
            value.activeSessionIds,
            activeSessions.map((session) => session.sessionId)
        )
    ) {
        issues.push(
            toGroupStateValidationIssue('Stored presence summary', 'Stored presence summary facts are inconsistent')
        );
    }
    return issues;
}

export function validatePresenceAdmission(
    admission: unknown,
    ref?: GroupRef
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const value = admission;
    if (!isGroupStateRecord(value)) {
        return [...issues, ...validateRecord(value, 'Presence admission')];
    }
    issues.push(...validateExactKeys(value, PRESENCE_ADMISSION_KEYS, 'Presence admission'));
    issues.push(...validateRequiredKeys(value, PRESENCE_ADMISSION_KEYS, 'Presence admission'));
    if (ref) {
        issues.push(...validateScopedRecord(value, ref, 'Presence admission'));
    }
    issues.push(...validateNonEmptyString(value.principalId, 'Presence admission principalId'));
    issues.push(...validatePositiveSafeInteger(value.updatedAtEpochMs, 'Presence admission updatedAtEpochMs'));
    if (!Array.isArray(value.admittedSessions)) {
        return [
            ...issues,
            toGroupStateValidationIssue(
                'Presence admission admittedSessions',
                'Presence admission sessions must be an array'
            )
        ];
    }
    issues.push(...validateAdmissionSessions(value.admittedSessions));
    return issues;
}

function validateAdmissionSessions(sessions: readonly unknown[]): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const sessionIdentities: Array<GroupPresenceAdmission['admittedSessions'][number]> = [];
    const sessionIds = new Set<string>();
    for (const session of sessions) {
        const sessionValue = session;
        if (!isGroupStateRecord(sessionValue)) {
            issues.push(...validateRecord(sessionValue, 'Presence admission session'));
            continue;
        }
        issues.push(...validateExactKeys(sessionValue, ADMITTED_SESSION_KEYS, 'Presence admission session'));
        issues.push(...validateRequiredKeys(sessionValue, ADMITTED_SESSION_KEYS, 'Presence admission session'));
        issues.push(...validateNonEmptyString(sessionValue.sessionId, 'Presence admission sessionId'));
        issues.push(...validateNonEmptyString(sessionValue.generationId, 'Presence admission generationId'));
        issues.push(...validatePositiveSafeInteger(
            sessionValue.generationVersion,
            'Presence admission generationVersion'
        ));
        issues.push(...validatePositiveSafeInteger(
            sessionValue.connectedAtEpochMs,
            'Presence admission connectedAtEpochMs'
        ));
        if (sessionValue.generationVersion !== sessionValue.connectedAtEpochMs) {
            issues.push(
                toGroupStateValidationIssue('Presence admission', 'Presence admission generation version is ambiguous')
            );
        }
        if (typeof sessionValue.sessionId === 'string' && sessionIds.has(sessionValue.sessionId)) {
            issues.push(
                toGroupStateValidationIssue('Presence admission', 'Presence admission sessionId must be unique')
            );
        }
        if (
            typeof sessionValue.sessionId !== 'string' || typeof sessionValue.generationId !== 'string' ||
            typeof sessionValue.generationVersion !== 'number' || typeof sessionValue.connectedAtEpochMs !== 'number'
        ) {
            continue;
        }
        sessionIds.add(sessionValue.sessionId);
        sessionIdentities.push({
            sessionId: sessionValue.sessionId,
            generationId: sessionValue.generationId,
            generationVersion: sessionValue.generationVersion,
            connectedAtEpochMs: sessionValue.connectedAtEpochMs
        });
    }
    const canonical = sessionIdentities.toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
    if (!jsonEquals(canonical, sessionIdentities)) {
        issues.push(
            toGroupStateValidationIssue('Presence admission', 'Presence admission sessions must be canonically sorted')
        );
    }
    return issues;
}

export function validateStoredGenerationValues(
    connectedAtEpochMs: number,
    generationVersion: number
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validatePositiveSafeInteger(connectedAtEpochMs, 'Stored presence connectedAtEpochMs'));
    issues.push(...validatePositiveSafeInteger(generationVersion, 'Stored presence generationVersion'));
    if (generationVersion !== connectedAtEpochMs) {
        issues.push(
            toGroupStateValidationIssue('Stored presence generation', 'Stored presence generation order is ambiguous')
        );
    }
    return issues;
}

export function compareGenerationOrder(
    left: readonly [number, string],
    right: readonly [number, string]
): number {
    return Math.sign(left[0] - right[0]) || left[1].localeCompare(right[1]);
}

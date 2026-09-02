import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { GROUP_LIFECYCLE_STATES, GROUP_TRANSPORT_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
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
    validateNullablePersistenceExpiry,
    validateNullablePositiveSafeInteger,
    validateOneOf,
    validatePositiveSafeInteger,
    validateRecord,
    validateRequiredKeys
} from '../group-state-validation-issues.ts';

const STORED_GROUP_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'slug',
    'displayName',
    'description',
    'kind',
    'status',
    'joinMode',
    'maxMembers',
    'maxSessionsPerMember',
    'metadata',
    'activeMemberCount',
    'ownerPrincipalId',
    'snapshotVersion',
    'metadataVersion',
    'rosterVersion',
    'presenceVersion',
    'created',
    'updated',
    'archived',
    'deleted',
    'expiresAtEpochMs',
    'emptySinceEpochMs',
    'purgeAfterEpochMs',
    'lifecycleState',
    'formationEpoch',
    'formationAttemptCount',
    'lastFormationOutcome',
    'establishmentStartedAtEpochMs',
    'formationElectorate',
    'acceptedLayoutIdentity',
    'transportState'
] as const;

const FORMATION_OUTCOME_KEYS = ['outcome', 'observedRate', 'atEpochMs', 'formationEpoch'] as const;

const STORED_MEMBER_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'principalId',
    'role',
    'status',
    'joined',
    'updated',
    'left',
    'removed',
    'banned',
    'invitedByPrincipalId',
    'invitationExpiresAtEpochMs'
] as const;

export function validateStoredGroup(group: unknown, ref: GroupRef): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const value = group;
    if (!isGroupStateRecord(value)) {
        return [...issues, ...validateRecord(value, 'Stored group value')];
    }
    issues.push(...validateExactKeys(value, STORED_GROUP_KEYS, 'Stored group value'));
    issues.push(...validateRequiredKeys(value, STORED_GROUP_KEYS, 'Stored group value'));
    issues.push(...validateScopedRecord(value, ref, 'Stored group'));
    issues.push(...validateStoredGroupFields(value));
    issues.push(...validateStoredGroupLifecycle(value));
    issues.push(...validateStoredGroupFormation(value));
    return issues;
}

export function validateStoredMember(
    member: unknown,
    ref: GroupRef,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const value = member;
    if (!isGroupStateRecord(value)) {
        return [...issues, ...validateRecord(value, `${label} value`)];
    }
    issues.push(...validateExactKeys(value, STORED_MEMBER_KEYS, `${label} value`));
    issues.push(...validateRequiredKeys(value, STORED_MEMBER_KEYS, `${label} value`));
    issues.push(...validateScopedRecord(value, ref, label));
    issues.push(...validateNonEmptyString(value.principalId, `${label} principalId`));
    issues.push(...validateOneOf(value.role, ['owner', 'admin', 'member'], `${label} role`));
    issues.push(...validateOneOf(
        value.status,
        ['invited', 'pending', 'active', 'left', 'removed', 'banned'],
        `${label} status`
    ));
    if (value.joined !== null) {
        issues.push(...validateAuditStamp(value.joined, `${label} joined`));
    }
    issues.push(...validateAuditStamp(value.updated, `${label} updated`));
    for (const key of ['left', 'removed', 'banned'] as const) {
        if (value[key] !== null) {
            issues.push(...validateAuditStamp(value[key], `${label} ${key}`));
        }
    }
    const lifecycleKey = value.status === 'left'
        ? 'left'
        : value.status === 'removed'
        ? 'removed'
        : value.status === 'banned'
        ? 'banned'
        : null;
    for (const terminal of ['left', 'removed', 'banned'] as const) {
        if ((terminal === lifecycleKey) !== (value[terminal] !== null)) {
            issues.push(toGroupStateValidationIssue(label, `${label} terminal lifecycle audits are inconsistent`));
        }
    }
    if ((value.status === 'invited' || value.status === 'pending') && value.joined !== null) {
        issues.push(toGroupStateValidationIssue(label, `${label} invited/pending member joined must be null`));
    }
    if (value.status === 'active' && value.joined === null) {
        issues.push(toGroupStateValidationIssue(label, `${label} active member joined is required`));
    }
    issues.push(...validateNullableNonEmptyString(value.invitedByPrincipalId, `${label} invitedByPrincipalId`));
    issues.push(...validateNullablePositiveSafeInteger(
        value.invitationExpiresAtEpochMs,
        `${label} invitationExpiresAtEpochMs`
    ));
    return issues;
}

export function validateScopedRecord(
    value: unknown,
    ref: GroupRef,
    label: string
): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, label);
    }
    return [
        ...validateNonEmptyString(value.applicationId, `${label} applicationId`),
        ...validateNonEmptyString(value.workspaceId, `${label} workspaceId`),
        ...validateNonEmptyString(value.groupId, `${label} groupId`),
        ...(value.applicationId !== ref.applicationId || value.workspaceId !== ref.workspaceId ||
                value.groupId !== ref.groupId
            ? [toGroupStateValidationIssue(label, `${label} scope differs from mutation group`)]
            : [])
    ];
}

export function validateAuditStamp(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const audit = value;
    if (!isGroupStateRecord(audit)) {
        return [...issues, ...validateRecord(audit, label)];
    }
    issues.push(...validateExactKeys(audit, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], label));
    issues.push(...validateRequiredKeys(audit, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], label));
    issues.push(...validateNonNegativeSafeInteger(audit.atEpochMs, `${label} atEpochMs`));
    issues.push(...validateMutationActor(audit.actor, `${label} actor`));
    issues.push(...validateNullableNonEmptyString(audit.reason, `${label} reason`));
    issues.push(...validateNullableNonEmptyString(audit.traceId, `${label} traceId`));
    issues.push(...validateNullableNonEmptyString(audit.requestId, `${label} requestId`));
    return issues;
}

export function validateMutationActor(
    value: unknown,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const actor = value;
    if (!isGroupStateRecord(actor)) {
        return [...issues, ...validateRecord(actor, label)];
    }
    issues.push(...validateOneOf(actor.kind, ['principal', 'session', 'service'], `${label} kind`));
    const keys = actor.kind === 'principal'
        ? ['kind', 'principalId']
        : actor.kind === 'session'
        ? ['kind', 'sessionId', 'principalId']
        : ['kind', 'serviceId'];
    issues.push(...validateExactKeys(actor, keys, label));
    issues.push(...validateRequiredKeys(actor, keys, label));
    for (const key of keys.filter((key) => key !== 'kind')) {
        issues.push(...validateNonEmptyString(actor[key], `${label} ${key}`));
    }
    return issues;
}

export function validateCausalRevision(
    value: unknown,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const revision = value;
    if (!isGroupStateRecord(revision)) {
        return [...issues, ...validateRecord(revision, `${label} causalRevision`)];
    }
    issues.push(...validateExactKeys(revision, ['groupRevision', 'presenceRevision'], `${label} causalRevision`));
    issues.push(...validateRequiredKeys(revision, ['groupRevision', 'presenceRevision'], `${label} causalRevision`));
    issues.push(...validateNonNegativeSafeInteger(revision.groupRevision, `${label} groupRevision`));
    issues.push(...validateNonNegativeSafeInteger(revision.presenceRevision, `${label} presenceRevision`));
    return issues;
}

function validateStoredFormationOutcome(
    value: Readonly<Record<string, unknown>>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (value.lastFormationOutcome !== null) {
        const outcome = value.lastFormationOutcome;
        if (!isGroupStateRecord(outcome)) {
            return [...issues, ...validateRecord(outcome, 'Stored group lastFormationOutcome')];
        }
        issues.push(...validateExactKeys(outcome, FORMATION_OUTCOME_KEYS, 'Stored group lastFormationOutcome'));
        issues.push(...validateOneOf(
            outcome.outcome,
            ['activated', 'activated-degraded', 'below-floor'],
            'Stored group lastFormationOutcome outcome'
        ));
        if (
            typeof outcome.observedRate !== 'number' ||
            !Number.isFinite(outcome.observedRate) ||
            outcome.observedRate < 0 ||
            outcome.observedRate > 1
        ) {
            issues.push(
                toGroupStateValidationIssue(
                    'Stored group',
                    'Stored group lastFormationOutcome observedRate must be within [0, 1]'
                )
            );
        }
        issues.push(...validatePositiveSafeInteger(outcome.atEpochMs, 'Stored group lastFormationOutcome atEpochMs'));
        issues.push(...validateNonNegativeSafeInteger(
            outcome.formationEpoch,
            'Stored group lastFormationOutcome formationEpoch'
        ));
    }
    return issues;
}

function validateStoredFormationElectorate(
    value: Readonly<Record<string, unknown>>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!Array.isArray(value.formationElectorate)) {
        return [
            toGroupStateValidationIssue(
                'Stored group formationElectorate',
                'Stored group formationElectorate must be an array'
            )
        ];
    }
    if (new Set(value.formationElectorate).size !== value.formationElectorate.length) {
        issues.push(
            toGroupStateValidationIssue(
                'Stored group',
                'Stored group formationElectorate must not repeat principal ids'
            )
        );
    }
    for (const principalId of value.formationElectorate) {
        issues.push(...validateNonEmptyString(principalId, 'Stored group formationElectorate entry'));
    }
    return issues;
}

function validateStoredAcceptedLayout(value: Readonly<Record<string, unknown>>): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (value.acceptedLayoutIdentity !== null) {
        const accepted = value.acceptedLayoutIdentity;
        if (!isGroupStateRecord(accepted)) {
            return [...issues, ...validateRecord(accepted, 'Stored group acceptedLayoutIdentity')];
        }
        issues.push(...validateExactKeys(accepted, GROUP_LAYOUT_IDENTITY_KEYS, 'Stored group acceptedLayoutIdentity'));
        issues.push(
            ...validateRequiredKeys(accepted, GROUP_LAYOUT_IDENTITY_KEYS, 'Stored group acceptedLayoutIdentity')
        );
        for (const key of ['groupRevision', 'presenceRevision', 'version'] as const) {
            issues.push(...validateNonNegativeSafeInteger(accepted[key], `Stored group acceptedLayoutIdentity ${key}`));
        }
        issues.push(...validateOneOf(
            accepted.state,
            GROUP_LAYOUT_IDENTITY_STATES,
            'Stored group acceptedLayoutIdentity state'
        ));
    }
    return issues;
}

function validateStoredGroupFields(value: Readonly<Record<string, unknown>>): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateNullableNonEmptyString(value.slug, 'Stored group slug'));
    issues.push(...validateNonEmptyString(value.displayName, 'Stored group displayName'));
    issues.push(...validateNullableNonEmptyString(value.description, 'Stored group description'));
    issues.push(...validateOneOf(value.kind, ['party', 'room', 'team', 'custom'], 'Stored group kind'));
    issues.push(...validateOneOf(value.status, ['active', 'archived', 'deleted'], 'Stored group status'));
    issues.push(...validateOneOf(value.joinMode, ['invite-only', 'code', 'open'], 'Stored group joinMode'));
    issues.push(...validateNullablePositiveSafeInteger(value.maxMembers, 'Stored group maxMembers'));
    issues.push(
        ...validateNullablePositiveSafeInteger(value.maxSessionsPerMember, 'Stored group maxSessionsPerMember')
    );
    issues.push(...validateRecord(value.metadata, 'Stored group metadata'));
    issues.push(...validatePositiveSafeInteger(value.activeMemberCount, 'Stored group activeMemberCount'));
    issues.push(...validateNonEmptyString(value.ownerPrincipalId, 'Stored group ownerPrincipalId'));
    issues.push(...validatePositiveSafeInteger(value.snapshotVersion, 'Stored group snapshotVersion'));
    issues.push(...validatePositiveSafeInteger(value.metadataVersion, 'Stored group metadataVersion'));
    issues.push(...validatePositiveSafeInteger(value.rosterVersion, 'Stored group rosterVersion'));
    issues.push(...validateNonNegativeSafeInteger(value.presenceVersion, 'Stored group presenceVersion'));
    return issues;
}

function validateStoredGroupLifecycle(value: Readonly<Record<string, unknown>>): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateAuditStamp(value.created, 'Stored group created'));
    issues.push(...validateAuditStamp(value.updated, 'Stored group updated'));
    if (value.archived !== null) {
        issues.push(...validateAuditStamp(value.archived, 'Stored group archived'));
    }
    if (value.deleted !== null) {
        issues.push(...validateAuditStamp(value.deleted, 'Stored group deleted'));
    }
    if (value.status === 'active' && (value.archived !== null || value.deleted !== null)) {
        issues.push(toGroupStateValidationIssue('Stored group', 'Stored active group lifecycle fields must be null'));
    }
    if (value.status === 'archived' && (value.archived === null || value.deleted !== null)) {
        issues.push(toGroupStateValidationIssue('Stored group', 'Stored archived group lifecycle fields are invalid'));
    }
    if (value.status === 'deleted' && value.deleted === null) {
        issues.push(toGroupStateValidationIssue('Stored group', 'Stored deleted group is missing lifecycle audit'));
    }
    return issues;
}

function validateStoredGroupFormation(value: Readonly<Record<string, unknown>>): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateNullablePositiveSafeInteger(value.expiresAtEpochMs, 'Stored group expiresAtEpochMs'));
    issues.push(...validateNullablePositiveSafeInteger(value.emptySinceEpochMs, 'Stored group emptySinceEpochMs'));
    issues.push(...validateNullablePersistenceExpiry(value.purgeAfterEpochMs, 'Stored group purgeAfterEpochMs'));
    issues.push(...validateOneOf(
        value.lifecycleState,
        GROUP_LIFECYCLE_STATES,
        'Stored group lifecycleState'
    ));
    issues.push(...validateNonNegativeSafeInteger(value.formationEpoch, 'Stored group formationEpoch'));
    issues.push(...validateNonNegativeSafeInteger(value.formationAttemptCount, 'Stored group formationAttemptCount'));
    issues.push(...validateStoredFormationOutcome(value));
    issues.push(...validateNullablePositiveSafeInteger(
        value.establishmentStartedAtEpochMs,
        'Stored group establishmentStartedAtEpochMs'
    ));
    issues.push(...validateStoredFormationElectorate(value));
    issues.push(...validateStoredAcceptedLayout(value));
    issues.push(...validateOneOf(value.transportState, GROUP_TRANSPORT_STATES, 'Stored group transportState'));
    return issues;
}

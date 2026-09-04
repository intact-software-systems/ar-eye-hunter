import { GROUP_ACTIVATION_CONDITIONS } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import {
    GROUP_ACTIVATION_STATUS_KEYS,
    GROUP_EVIDENCE_WATERMARK_KEYS
} from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';
import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import {
    GROUP_ESTABLISHMENT_TRANSPORTS,
    GROUP_LIFECYCLE_STATES,
    GROUP_MEMBER_POLICY_KEYS,
    GROUP_TRANSPORT_STATES
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { MAX_GROUP_CONCURRENT_EDGE_SETUPS } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import type { AuditStamp, Group, GroupMember, GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import { validateStoredGroupActivationStatus } from './validate-persisted-group-activation-status.ts';

import {
    assertExactKeys,
    assertRequiredKeys,
    nullableNonEmptyString,
    nullablePositiveSafeInteger,
    requireNonEmptyString,
    requireNonNegativeSafeInteger,
    requireOneOf,
    requirePositiveSafeInteger,
    requireRecord
} from '../group-state-validation-primitives.ts';

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
    'transportState',
    'memberPolicy',
    'activationStatus'
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

type StoredGroupRecord = Readonly<Record<string, unknown>>;

export function validateStoredGroup(group: unknown, ref: GroupRef): asserts group is Group {
    const value = requireRecord(group, 'Stored group value');
    assertExactKeys(value, STORED_GROUP_KEYS, 'Stored group value');
    assertRequiredKeys(value, STORED_GROUP_KEYS, 'Stored group value');
    validateScopedRecord(value, ref, 'Stored group');
    nullableNonEmptyString(value.slug, 'Stored group slug');
    requireNonEmptyString(value.displayName, 'Stored group displayName');
    nullableNonEmptyString(value.description, 'Stored group description');
    requireOneOf(value.kind, ['party', 'room', 'team', 'custom'], 'Stored group kind');
    requireOneOf(value.status, ['active', 'archived', 'deleted'], 'Stored group status');
    requireOneOf(value.joinMode, ['invite-only', 'code', 'open'], 'Stored group joinMode');
    nullablePositiveSafeInteger(value.maxMembers, 'Stored group maxMembers');
    nullablePositiveSafeInteger(value.maxSessionsPerMember, 'Stored group maxSessionsPerMember');
    requireRecord(value.metadata, 'Stored group metadata');
    requirePositiveSafeInteger(value.activeMemberCount, 'Stored group activeMemberCount');
    requireNonEmptyString(value.ownerPrincipalId, 'Stored group ownerPrincipalId');
    requirePositiveSafeInteger(value.snapshotVersion, 'Stored group snapshotVersion');
    requirePositiveSafeInteger(value.metadataVersion, 'Stored group metadataVersion');
    requirePositiveSafeInteger(value.rosterVersion, 'Stored group rosterVersion');
    requireNonNegativeSafeInteger(value.presenceVersion, 'Stored group presenceVersion');
    validateAuditStamp(value.created, 'Stored group created');
    validateAuditStamp(value.updated, 'Stored group updated');
    if (value.archived !== null) {
        validateAuditStamp(value.archived, 'Stored group archived');
    }
    if (value.deleted !== null) {
        validateAuditStamp(value.deleted, 'Stored group deleted');
    }
    if (value.status === 'active' && (value.archived !== null || value.deleted !== null)) {
        throw new TypeError('Stored active group lifecycle fields must be null');
    }
    if (value.status === 'archived' && (value.archived === null || value.deleted !== null)) {
        throw new TypeError('Stored archived group lifecycle fields are invalid');
    }
    if (value.status === 'deleted' && value.deleted === null) {
        throw new TypeError('Stored deleted group is missing lifecycle audit');
    }
    nullablePositiveSafeInteger(value.expiresAtEpochMs, 'Stored group expiresAtEpochMs');
    nullablePositiveSafeInteger(value.emptySinceEpochMs, 'Stored group emptySinceEpochMs');
    nullablePositiveSafeInteger(value.purgeAfterEpochMs, 'Stored group purgeAfterEpochMs');
    requireOneOf(
        value.lifecycleState,
        GROUP_LIFECYCLE_STATES,
        'Stored group lifecycleState'
    );
    requireNonNegativeSafeInteger(value.formationEpoch, 'Stored group formationEpoch');
    requireNonNegativeSafeInteger(value.formationAttemptCount, 'Stored group formationAttemptCount');
    if (value.lastFormationOutcome !== null) {
        const outcome = requireRecord(value.lastFormationOutcome, 'Stored group lastFormationOutcome');
        assertExactKeys(outcome, FORMATION_OUTCOME_KEYS, 'Stored group lastFormationOutcome');
        requireOneOf(
            outcome.outcome,
            ['activated', 'activated-degraded', 'below-floor'],
            'Stored group lastFormationOutcome outcome'
        );
        if (
            typeof outcome.observedRate !== 'number' ||
            !Number.isFinite(outcome.observedRate) ||
            outcome.observedRate < 0 ||
            outcome.observedRate > 1
        ) {
            throw new TypeError('Stored group lastFormationOutcome observedRate must be within [0, 1]');
        }
        requirePositiveSafeInteger(outcome.atEpochMs, 'Stored group lastFormationOutcome atEpochMs');
        requireNonNegativeSafeInteger(
            outcome.formationEpoch,
            'Stored group lastFormationOutcome formationEpoch'
        );
    }
    nullablePositiveSafeInteger(
        value.establishmentStartedAtEpochMs,
        'Stored group establishmentStartedAtEpochMs'
    );
    if (!Array.isArray(value.formationElectorate)) {
        throw new TypeError('Stored group formationElectorate must be an array');
    }
    if (new Set(value.formationElectorate).size !== value.formationElectorate.length) {
        throw new TypeError('Stored group formationElectorate must not repeat principal ids');
    }
    for (const principalId of value.formationElectorate) {
        requireNonEmptyString(principalId, 'Stored group formationElectorate entry');
    }
    if (value.acceptedLayoutIdentity !== null) {
        validateStoredGroupLayoutIdentity(
            requireRecord(value.acceptedLayoutIdentity, 'Stored group acceptedLayoutIdentity'),
            'Stored group acceptedLayoutIdentity'
        );
    }
    requireOneOf(value.transportState, GROUP_TRANSPORT_STATES, 'Stored group transportState');
    validateStoredGroupMemberPolicy(requireRecord(value.memberPolicy, 'Stored group memberPolicy'));
    if (value.activationStatus !== null) {
        validateStoredGroupActivationStatus(
            requireRecord(value.activationStatus, 'Stored group activationStatus'),
            validateStoredGroupLayoutIdentity
        );
    }
}

function validateStoredGroupLayoutIdentity(identity: StoredGroupRecord, label: string): void {
    assertExactKeys(identity, GROUP_LAYOUT_IDENTITY_KEYS, label);
    assertRequiredKeys(identity, GROUP_LAYOUT_IDENTITY_KEYS, label);
    for (const key of ['groupRevision', 'presenceRevision', 'version'] as const) {
        requireNonNegativeSafeInteger(identity[key], `${label} ${key}`);
    }
    requireOneOf(identity.state, GROUP_LAYOUT_IDENTITY_STATES, `${label} state`);
}

function validateStoredGroupMemberPolicy(memberPolicy: StoredGroupRecord): void {
    assertExactKeys(memberPolicy, GROUP_MEMBER_POLICY_KEYS, 'Stored group memberPolicy');
    assertRequiredKeys(memberPolicy, GROUP_MEMBER_POLICY_KEYS, 'Stored group memberPolicy');
    requirePositiveSafeInteger(
        memberPolicy.maxConcurrentEdgeSetups,
        'Stored group memberPolicy maxConcurrentEdgeSetups'
    );
    if (memberPolicy.maxConcurrentEdgeSetups > MAX_GROUP_CONCURRENT_EDGE_SETUPS) {
        throw new TypeError('Stored group memberPolicy maxConcurrentEdgeSetups exceeds the policy bound');
    }
    requireOneOf(
        memberPolicy.transports,
        GROUP_ESTABLISHMENT_TRANSPORTS,
        'Stored group memberPolicy transports'
    );
}

export function validateStoredMember(
    member: unknown,
    ref: GroupRef,
    label: string
): asserts member is GroupMember {
    const value = requireRecord(member, `${label} value`);
    assertExactKeys(value, STORED_MEMBER_KEYS, `${label} value`);
    assertRequiredKeys(value, STORED_MEMBER_KEYS, `${label} value`);
    validateScopedRecord(value, ref, label);
    requireNonEmptyString(value.principalId, `${label} principalId`);
    requireOneOf(value.role, ['owner', 'admin', 'member'], `${label} role`);
    requireOneOf(
        value.status,
        ['invited', 'pending', 'active', 'left', 'removed', 'banned'],
        `${label} status`
    );
    if (value.joined !== null) {
        validateAuditStamp(value.joined, `${label} joined`);
    }
    validateAuditStamp(value.updated, `${label} updated`);
    for (const key of ['left', 'removed', 'banned'] as const) {
        if (value[key] !== null) {
            validateAuditStamp(value[key], `${label} ${key}`);
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
            throw new TypeError(`${label} terminal lifecycle audits are inconsistent`);
        }
    }
    if ((value.status === 'invited' || value.status === 'pending') && value.joined !== null) {
        throw new TypeError(`${label} invited/pending member joined must be null`);
    }
    if (value.status === 'active' && value.joined === null) {
        throw new TypeError(`${label} active member joined is required`);
    }
    nullableNonEmptyString(value.invitedByPrincipalId, `${label} invitedByPrincipalId`);
    nullablePositiveSafeInteger(
        value.invitationExpiresAtEpochMs,
        `${label} invitationExpiresAtEpochMs`
    );
}

export function validatePersistedGroup(value: unknown, ref: GroupRef): asserts value is Group {
    validateStoredGroup(value, ref);
}

export function validatePersistedGroupMember(
    value: unknown,
    ref: GroupRef
): asserts value is GroupMember {
    validateStoredMember(value, ref, 'Stored group member');
}

export function validateScopedValue(
    value: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
    ref: GroupRef,
    label: string
): void {
    requireNonEmptyString(value.applicationId, `${label} applicationId`);
    requireNonEmptyString(value.workspaceId, `${label} workspaceId`);
    requireNonEmptyString(value.groupId, `${label} groupId`);
    if (
        value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId ||
        value.groupId !== ref.groupId
    ) {
        throw new TypeError(`${label} scope differs from mutation group`);
    }
}

export function validateScopedRecord(
    value: StoredGroupRecord,
    ref: GroupRef,
    label: string
): void {
    requireNonEmptyString(value.applicationId, `${label} applicationId`);
    requireNonEmptyString(value.workspaceId, `${label} workspaceId`);
    requireNonEmptyString(value.groupId, `${label} groupId`);
    if (
        value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId ||
        value.groupId !== ref.groupId
    ) {
        throw new TypeError(`${label} scope differs from mutation group`);
    }
}

export function validateAuditStamp(value: unknown, label: string): asserts value is AuditStamp {
    const audit = requireRecord(value, label);
    assertExactKeys(audit, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], label);
    assertRequiredKeys(audit, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], label);
    requireNonNegativeSafeInteger(audit.atEpochMs, `${label} atEpochMs`);
    validateMutationActor(audit.actor, `${label} actor`);
    nullableNonEmptyString(audit.reason, `${label} reason`);
    nullableNonEmptyString(audit.traceId, `${label} traceId`);
    nullableNonEmptyString(audit.requestId, `${label} requestId`);
}

export function validateMutationActor(
    value: unknown,
    label: string
): asserts value is MutationActor {
    const actor = requireRecord(value, label);
    requireOneOf(actor.kind, ['principal', 'session', 'service'], `${label} kind`);
    const keys = actor.kind === 'principal'
        ? ['kind', 'principalId']
        : actor.kind === 'session'
        ? ['kind', 'sessionId', 'principalId']
        : ['kind', 'serviceId'];
    assertExactKeys(actor, keys, label);
    assertRequiredKeys(actor, keys, label);
    for (const key of keys.filter((key) => key !== 'kind')) {
        requireNonEmptyString(actor[key], `${label} ${key}`);
    }
}

export function validateCausalRevision(
    value: unknown,
    label: string
): asserts value is GroupStateCausalRevision {
    const revision = requireRecord(value, `${label} causalRevision`);
    assertExactKeys(revision, ['groupRevision', 'presenceRevision'], `${label} causalRevision`);
    assertRequiredKeys(revision, ['groupRevision', 'presenceRevision'], `${label} causalRevision`);
    requireNonNegativeSafeInteger(revision.groupRevision, `${label} groupRevision`);
    requireNonNegativeSafeInteger(revision.presenceRevision, `${label} presenceRevision`);
}

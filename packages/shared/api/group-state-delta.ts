import { validateAuthoritativeGroupEvent } from './authoritative-state-validation.ts';
import { compareGroupCausalRevision } from './group-client-views.ts';
import { GROUP_LAYOUT_IDENTITY_KEYS, GROUP_LAYOUT_IDENTITY_STATES } from './group-lifecycle/group-layout-identity.ts';
import { GROUP_LIFECYCLE_STATES } from './group-lifecycle/group-lifecycle-policy.ts';
import type { Group, GroupEvent, GroupMember, GroupPresenceSession, GroupStateCausalRevision } from './group-types.ts';
import type { StateScope } from './state-types.ts';

/**
 * The `group-state.event` WS row payload under delta dissemination. It wraps
 * the durable GroupEvent with the resulting-state slice a browser needs to
 * reapply the transition onto a cached snapshot whose revision equals
 * `predecessorCausalRevision`. A summary no-op expansion has no CAS
 * predecessor and stamps `predecessorCausalRevision === resultingCausalRevision`.
 * `activeSessionIds` is always the complete resulting identity set because
 * snapshot assembly TTL-filters sessions beyond the mutation's own slice.
 * `audienceSessionIds` is the persisted immutable delivery audience computed
 * at write time; delivery intersects it with locally open connections only.
 */
export interface GroupStateDeltaEnvelope {
    readonly event: GroupEvent;
    readonly predecessorCausalRevision: GroupStateCausalRevision;
    readonly resultingCausalRevision: GroupStateCausalRevision;
    readonly members: readonly GroupMember[];
    readonly removedMemberPrincipalIds: readonly string[];
    readonly sessions: readonly GroupPresenceSession[];
    readonly removedSessionIds: readonly string[];
    readonly activeSessionIds: readonly string[];
    readonly group: Group;
    readonly memberCount: number;
    readonly onlineMemberCount: number;
    readonly audienceSessionIds: readonly string[];
}

const ENVELOPE_KEYS = [
    'event',
    'predecessorCausalRevision',
    'resultingCausalRevision',
    'members',
    'removedMemberPrincipalIds',
    'sessions',
    'removedSessionIds',
    'activeSessionIds',
    'group',
    'memberCount',
    'onlineMemberCount',
    'audienceSessionIds'
];
const GROUP_KEYS = [
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
];
const GROUP_MEMBER_KEYS = [
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
];
const GROUP_SESSION_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'sessionId',
    'principalId',
    'generationId',
    'generationVersion',
    'status',
    'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
    'disconnectedAtEpochMs',
    'disconnectReason'
];
const AUDIT_KEYS = ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'];

export function validateGroupStateDeltaEnvelope(
    value: unknown,
    expected?: StateScope & Readonly<{ groupId?: string; }>
): asserts value is GroupStateDeltaEnvelope {
    const envelope = record(value, 'GroupStateDeltaEnvelope');
    exact(envelope, ENVELOPE_KEYS, 'GroupStateDeltaEnvelope');
    validateAuthoritativeGroupEvent(envelope.event, expected);
    const ref = {
        applicationId: envelope.event.applicationId,
        workspaceId: envelope.event.workspaceId,
        groupId: envelope.event.groupId
    };
    const predecessor = causalRevision(
        envelope.predecessorCausalRevision,
        'GroupStateDeltaEnvelope.predecessorCausalRevision'
    );
    const resulting = causalRevision(
        envelope.resultingCausalRevision,
        'GroupStateDeltaEnvelope.resultingCausalRevision'
    );
    const comparison = compareGroupCausalRevision(resulting, predecessor);
    if (comparison !== 'equal' && comparison !== 'dominates') {
        fail('GroupStateDeltaEnvelope resulting revision does not follow its predecessor');
    }
    const group = validateDeltaGroup(envelope.group, ref, resulting);
    validateDeltaMembers(envelope, ref);
    const activeSessionIds = validateDeltaSessionIdentitySets(envelope, ref);
    nonNegativeInteger(envelope.memberCount, 'GroupStateDeltaEnvelope.memberCount');
    nonNegativeInteger(envelope.onlineMemberCount, 'GroupStateDeltaEnvelope.onlineMemberCount');
    if (
        envelope.memberCount !== group.activeMemberCount ||
        envelope.onlineMemberCount > envelope.memberCount ||
        envelope.onlineMemberCount > activeSessionIds.size ||
        activeSessionIds.size > 0 !== envelope.onlineMemberCount > 0
    ) {
        fail('GroupStateDeltaEnvelope aggregate counts are inconsistent');
    }
    if (group.status !== 'active' && activeSessionIds.size !== 0) {
        fail('GroupStateDeltaEnvelope inactive group has active sessions');
    }
}

function validateDeltaGroup(
    value: unknown,
    ref: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>,
    resulting: GroupStateCausalRevision
): Readonly<{ activeMemberCount: number; status: string; }> {
    const label = 'GroupStateDeltaEnvelope.group';
    const group = record(value, label);
    exact(group, GROUP_KEYS, label);
    sameGroupRef(group, ref, label);
    nullableString(group.slug, `${label}.slug`);
    nonEmptyString(group.displayName, `${label}.displayName`);
    nullableString(group.description, `${label}.description`);
    enumValue(group.kind, ['party', 'room', 'team', 'custom'], `${label}.kind`);
    enumValue(group.status, ['active', 'archived', 'deleted'], `${label}.status`);
    enumValue(group.joinMode, ['invite-only', 'code', 'open'], `${label}.joinMode`);
    nullablePositiveInteger(group.maxMembers, `${label}.maxMembers`);
    nullablePositiveInteger(group.maxSessionsPerMember, `${label}.maxSessionsPerMember`);
    record(group.metadata, `${label}.metadata`);
    nonNegativeInteger(group.activeMemberCount, `${label}.activeMemberCount`);
    nonEmptyString(group.ownerPrincipalId, `${label}.ownerPrincipalId`);
    for (const key of ['snapshotVersion', 'metadataVersion', 'rosterVersion'] as const) {
        positiveInteger(group[key], `${label}.${key}`);
    }
    nonNegativeInteger(group.presenceVersion, `${label}.presenceVersion`);
    if (
        group.snapshotVersion !== resulting.groupRevision ||
        group.presenceVersion !== resulting.presenceRevision
    ) {
        fail(`${label} revisions differ from resultingCausalRevision`);
    }
    validateAudit(group.created, `${label}.created`);
    validateAudit(group.updated, `${label}.updated`);
    nullableAudit(group.archived, `${label}.archived`);
    nullableAudit(group.deleted, `${label}.deleted`);
    validateGroupLifecycle(group, label);
    for (const key of ['expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs'] as const) {
        nullablePositiveInteger(group[key], `${label}.${key}`);
    }
    enumValue(
        group.lifecycleState,
        GROUP_LIFECYCLE_STATES,
        `${label}.lifecycleState`
    );
    nonNegativeInteger(group.formationEpoch, `${label}.formationEpoch`);
    nonNegativeInteger(group.formationAttemptCount, `${label}.formationAttemptCount`);
    if (group.lastFormationOutcome !== null) {
        const outcome = record(group.lastFormationOutcome, `${label}.lastFormationOutcome`);
        exact(
            outcome,
            ['outcome', 'observedRate', 'atEpochMs', 'formationEpoch'],
            `${label}.lastFormationOutcome`
        );
        enumValue(
            outcome.outcome,
            ['activated', 'activated-degraded', 'below-floor'],
            `${label}.lastFormationOutcome.outcome`
        );
        if (
            typeof outcome.observedRate !== 'number' ||
            !Number.isFinite(outcome.observedRate) ||
            outcome.observedRate < 0 ||
            outcome.observedRate > 1
        ) {
            fail(`${label}.lastFormationOutcome.observedRate must be within [0, 1]`);
        }
        positiveInteger(outcome.atEpochMs, `${label}.lastFormationOutcome.atEpochMs`);
        nonNegativeInteger(outcome.formationEpoch, `${label}.lastFormationOutcome.formationEpoch`);
    }
    nullablePositiveInteger(
        group.establishmentStartedAtEpochMs,
        `${label}.establishmentStartedAtEpochMs`
    );
    const electorate = array(group.formationElectorate, `${label}.formationElectorate`);
    const electoratePrincipalIds = new Set(electorate);
    if (electoratePrincipalIds.size !== electorate.length) {
        fail(`${label}.formationElectorate must not repeat principal ids`);
    }
    for (const principalId of electorate) {
        if (typeof principalId !== 'string' || principalId.length === 0) {
            fail(`${label}.formationElectorate entries must be non-empty strings`);
        }
    }
    if (group.acceptedLayoutIdentity !== null) {
        const accepted = record(group.acceptedLayoutIdentity, `${label}.acceptedLayoutIdentity`);
        exact(accepted, GROUP_LAYOUT_IDENTITY_KEYS, `${label}.acceptedLayoutIdentity`);
        for (const key of ['groupRevision', 'presenceRevision', 'version'] as const) {
            nonNegativeInteger(accepted[key], `${label}.acceptedLayoutIdentity.${key}`);
        }
        enumValue(accepted.state, GROUP_LAYOUT_IDENTITY_STATES, `${label}.acceptedLayoutIdentity.state`);
    }
    enumValue(group.transportState, ['flowing', 'halted'], `${label}.transportState`);
    return { activeMemberCount: group.activeMemberCount, status: group.status };
}

function validateGroupLifecycle(group: Record<string, unknown>, label: string): void {
    if (group.status === 'active' && (group.archived !== null || group.deleted !== null)) {
        fail(`${label} lifecycle is invalid`);
    }
    if (group.status === 'archived' && (group.archived === null || group.deleted !== null)) {
        fail(`${label} lifecycle is invalid`);
    }
    if (group.status === 'deleted' && group.deleted === null) {
        fail(`${label} lifecycle is invalid`);
    }
}

function validateDeltaMembers(
    envelope: Record<string, unknown>,
    ref: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>
): void {
    const members = array(envelope.members, 'GroupStateDeltaEnvelope.members');
    const memberPrincipalIds = new Set<string>();
    for (const item of members) {
        const principalId = validateDeltaMember(item, ref);
        if (memberPrincipalIds.has(principalId)) {
            fail('GroupStateDeltaEnvelope has duplicate members');
        }
        memberPrincipalIds.add(principalId);
    }
    const removed = uniqueStringArray(
        envelope.removedMemberPrincipalIds,
        'GroupStateDeltaEnvelope.removedMemberPrincipalIds'
    );
    for (const principalId of removed) {
        if (memberPrincipalIds.has(principalId)) {
            fail('GroupStateDeltaEnvelope removed member is also carried as a member');
        }
    }
}

function validateDeltaMember(
    value: unknown,
    ref: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>
): string {
    const label = 'GroupStateDeltaEnvelope.member';
    const member = record(value, label);
    exact(member, GROUP_MEMBER_KEYS, label);
    sameGroupRef(member, ref, label);
    nonEmptyString(member.principalId, `${label}.principalId`);
    enumValue(member.role, ['owner', 'admin', 'member'], `${label}.role`);
    enumValue(
        member.status,
        ['invited', 'pending', 'active', 'left', 'removed', 'banned'],
        `${label}.status`
    );
    nullableAudit(member.joined, `${label}.joined`);
    validateAudit(member.updated, `${label}.updated`);
    nullableAudit(member.left, `${label}.left`);
    nullableAudit(member.removed, `${label}.removed`);
    nullableAudit(member.banned, `${label}.banned`);
    nullableString(member.invitedByPrincipalId, `${label}.invitedByPrincipalId`);
    nullablePositiveInteger(member.invitationExpiresAtEpochMs, `${label}.invitationExpiresAtEpochMs`);
    if ((member.status === 'invited' || member.status === 'pending') && member.joined !== null) {
        fail(`${label} invited/pending member joined must be null`);
    }
    if (member.status === 'active' && member.joined === null) {
        fail(`${label} active member joined is required`);
    }
    const expectedTerminal = member.status === 'left' || member.status === 'removed' || member.status === 'banned'
        ? member.status
        : null;
    for (const terminal of ['left', 'removed', 'banned'] as const) {
        if ((terminal === expectedTerminal) !== (member[terminal] !== null)) {
            fail(`${label} terminal lifecycle is invalid`);
        }
    }
    return member.principalId;
}

function validateDeltaSessionIdentitySets(
    envelope: Record<string, unknown>,
    ref: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>
): ReadonlySet<string> {
    const activeSessionIds = new Set(
        uniqueStringArray(envelope.activeSessionIds, 'GroupStateDeltaEnvelope.activeSessionIds')
    );
    const sessions = array(envelope.sessions, 'GroupStateDeltaEnvelope.sessions');
    const sessionIds = new Set<string>();
    for (const item of sessions) {
        const sessionId = validateDeltaSession(item, ref);
        if (sessionIds.has(sessionId)) {
            fail('GroupStateDeltaEnvelope has duplicate sessions');
        }
        if (!activeSessionIds.has(sessionId)) {
            fail('GroupStateDeltaEnvelope session is outside the active identity set');
        }
        sessionIds.add(sessionId);
    }
    const removedSessionIds = uniqueStringArray(
        envelope.removedSessionIds,
        'GroupStateDeltaEnvelope.removedSessionIds'
    );
    for (const sessionId of removedSessionIds) {
        if (activeSessionIds.has(sessionId)) {
            fail('GroupStateDeltaEnvelope removed session is still in the active identity set');
        }
    }
    uniqueStringArray(envelope.audienceSessionIds, 'GroupStateDeltaEnvelope.audienceSessionIds');
    return activeSessionIds;
}

function validateDeltaSession(
    value: unknown,
    ref: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>
): string {
    const label = 'GroupStateDeltaEnvelope.session';
    const session = record(value, label);
    exact(session, GROUP_SESSION_KEYS, label);
    sameGroupRef(session, ref, label);
    nonEmptyString(session.sessionId, `${label}.sessionId`);
    nonEmptyString(session.principalId, `${label}.principalId`);
    nonEmptyString(session.generationId, `${label}.generationId`);
    positiveInteger(session.generationVersion, `${label}.generationVersion`);
    positiveInteger(session.connectedAtEpochMs, `${label}.connectedAtEpochMs`);
    positiveInteger(session.lastHeartbeatAtEpochMs, `${label}.lastHeartbeatAtEpochMs`);
    positiveInteger(session.expiresAtEpochMs, `${label}.expiresAtEpochMs`);
    if (
        session.lastHeartbeatAtEpochMs < session.connectedAtEpochMs ||
        session.expiresAtEpochMs < session.lastHeartbeatAtEpochMs
    ) {
        fail(`${label} timestamps are causally inconsistent`);
    }
    if (
        session.status !== 'active' ||
        session.disconnectedAtEpochMs !== null ||
        session.disconnectReason !== null
    ) {
        fail(`${label} lifecycle is invalid`);
    }
    return session.sessionId;
}

function validateAudit(value: unknown, label: string): void {
    const audit = record(value, label);
    exact(audit, AUDIT_KEYS, label);
    nonNegativeInteger(audit.atEpochMs, `${label}.atEpochMs`);
    validateActor(audit.actor, `${label}.actor`);
    nullableString(audit.reason, `${label}.reason`);
    nullableString(audit.traceId, `${label}.traceId`);
    nullableString(audit.requestId, `${label}.requestId`);
}

function validateActor(value: unknown, label: string): void {
    const actor = record(value, label);
    if (actor.kind === 'principal') {
        exact(actor, ['kind', 'principalId'], label);
        nonEmptyString(actor.principalId, `${label}.principalId`);
        return;
    }
    if (actor.kind === 'session') {
        exact(actor, ['kind', 'sessionId', 'principalId'], label);
        nonEmptyString(actor.sessionId, `${label}.sessionId`);
        nonEmptyString(actor.principalId, `${label}.principalId`);
        return;
    }
    if (actor.kind === 'service') {
        exact(actor, ['kind', 'serviceId'], label);
        nonEmptyString(actor.serviceId, `${label}.serviceId`);
        return;
    }
    fail(`${label}.kind is invalid`);
}

function nullableAudit(value: unknown, label: string): void {
    if (value !== null) {
        validateAudit(value, label);
    }
}

function sameGroupRef(
    value: Record<string, unknown>,
    ref: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>,
    label: string
): void {
    if (
        value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId ||
        value.groupId !== ref.groupId
    ) {
        fail(`${label} scope is inconsistent`);
    }
}

function causalRevision(value: unknown, label: string): GroupStateCausalRevision {
    const revision = record(value, label);
    exact(revision, ['groupRevision', 'presenceRevision'], label);
    nonNegativeInteger(revision.groupRevision, `${label}.groupRevision`);
    nonNegativeInteger(revision.presenceRevision, `${label}.presenceRevision`);
    return {
        groupRevision: revision.groupRevision,
        presenceRevision: revision.presenceRevision
    };
}

function uniqueStringArray(value: unknown, label: string): readonly string[] {
    const values = array(value, label);
    const strings: string[] = [];
    for (const item of values) {
        nonEmptyString(item, `${label} item`);
        strings.push(item);
    }
    if (new Set(strings).size !== strings.length) {
        fail(`${label} has duplicate entries`);
    }
    return strings;
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`);
    }
    return value;
}

function enumValue(
    value: unknown,
    allowed: readonly string[],
    label: string
): asserts value is string {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        fail(`${label} is invalid`);
    }
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    const missing = keys.find((key) => !Object.hasOwn(value, key));
    if (missing) {
        fail(`${label} is missing ${missing}`);
    }
    const allowed = new Set(keys);
    const extra = Object.keys(value).find((key) => !allowed.has(key));
    if (extra) {
        fail(`${label} has unexpected ${extra}`);
    }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        fail(`${label} is invalid`);
    }
}

function nullableString(value: unknown, label: string): void {
    if (value !== null) {
        nonEmptyString(value, label);
    }
}

function nullablePositiveInteger(value: unknown, label: string): void {
    if (value !== null) {
        positiveInteger(value, label);
    }
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        fail(`${label} is invalid`);
    }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
        fail(`${label} is invalid`);
    }
}

function fail(message: string): never {
    throw new TypeError(message);
}

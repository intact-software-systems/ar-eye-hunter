import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '../group-lifecycle/group-layout-identity.ts';
import {
    GROUP_LIFECYCLE_STATES,
    GROUP_TRANSPORT_STATES
} from '../group-lifecycle/group-lifecycle-policy.ts';
import type { StateScope } from '../state-types.ts';
import {
    authoritativeStateAssertion,
    AuthoritativeStateValidation,
    collectAuthoritativeStateValidationIssues,
    type AuthoritativeStateRecord,
    type AuthoritativeStateValidationIssue
} from './validation-issues.ts';

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
const GROUP_EVENT_KEYS = [
    'applicationId',
    'workspaceId',
    'groupId',
    'eventId',
    'eventType',
    'snapshotVersion',
    'causalRevision',
    'occurredAtEpochMs',
    'actor',
    'reason',
    'traceId',
    'requestId',
    'payload'
];
const GROUP_EVENT_TYPES = [
    'group-created',
    'group-updated',
    'group-archived',
    'group-deleted',
    'member-invited',
    'member-admission-requested',
    'member-joined',
    'member-left',
    'member-removed',
    'member-banned',
    'member-unbanned',
    'member-role-changed',
    'ownership-transferred',
    'session-connected',
    'session-heartbeat',
    'session-disconnected'
];

interface GroupSnapshotCollections {
    readonly activeMemberIds: ReadonlySet<string>;
    readonly activeOwnerIds: ReadonlySet<string>;
    readonly onlinePrincipalIds: ReadonlySet<string>;
    readonly sessionCount: number;
}

interface GroupSnapshotSessionPredecessor {
    readonly group: unknown;
    readonly activeMemberIds: ReadonlySet<string>;
    readonly sessionIds: ReadonlySet<string>;
}

interface AuthoritativeGroupValidationContext {
    readonly expected?: StateScope & Readonly<{ groupId?: string; }>;
    readonly validation: AuthoritativeStateValidation;
}

interface GroupRelationshipValidation {
    readonly group: unknown;
    readonly path: string;
    readonly validation: AuthoritativeStateValidation;
}

export function validateAuthoritativeGroupEventIssues(
    value: unknown,
    expected?: StateScope & Readonly<{ groupId?: string; }>
): readonly AuthoritativeStateValidationIssue[] {
    return collectAuthoritativeStateValidationIssues((validation) =>
        validateAuthoritativeGroupEventValue(value, expected, validation)
    );
}

export function assertAuthoritativeGroupEvent<Value>(
    value: Value,
    expected?: StateScope & Readonly<{ groupId?: string; }>
): void {
    validateAuthoritativeGroupEventValue(value, expected, authoritativeStateAssertion);
}

function validateAuthoritativeGroupEventValue<Value>(
    value: Value,
    expected: StateScope & Readonly<{ groupId?: string; }> | undefined,
    validation: AuthoritativeStateValidation
): void {
    if (!validation.isRecord(value)) {
        validation.record(value, 'GroupEvent');
        return;
    }
    validation.exactKeys(value, GROUP_EVENT_KEYS, 'GroupEvent');
    validateGroupIdentity(value, 'GroupEvent', { expected, validation });
    if (expected?.groupId !== undefined && value.groupId !== expected.groupId) {
        validation.issue('GroupEvent.groupId', 'GroupEvent is outside the requested group');
    }
    validation.string(value.eventId, 'GroupEvent.eventId');
    validation.enum(value.eventType, GROUP_EVENT_TYPES, 'GroupEvent.eventType');
    validation.integer(value.snapshotVersion, 0, 'GroupEvent.snapshotVersion');
    validation.causalRevision(value.causalRevision, 'GroupEvent.causalRevision');
    validation.integer(value.occurredAtEpochMs, 0, 'GroupEvent.occurredAtEpochMs');
    validation.actor(value.actor, 'GroupEvent.actor');
    validation.nullableStrings(value, ['reason', 'traceId', 'requestId'], 'GroupEvent');
    validation.record(value.payload, 'GroupEvent.payload');
}

export function validateAuthoritativeGroupSnapshotIssues(
    value: unknown,
    scope?: StateScope
): readonly AuthoritativeStateValidationIssue[] {
    return collectAuthoritativeStateValidationIssues((validation) =>
        validateAuthoritativeGroupSnapshotValue(value, scope, validation)
    );
}

export function assertAuthoritativeGroupSnapshot<Value>(value: Value, scope?: StateScope): void {
    validateAuthoritativeGroupSnapshotValue(value, scope, authoritativeStateAssertion);
}

function validateAuthoritativeGroupSnapshotValue<Value>(
    value: Value,
    scope: StateScope | undefined,
    validation: AuthoritativeStateValidation
): void {
    if (!validation.isRecord(value)) {
        validation.record(value, 'GroupSnapshot');
        return;
    }
    validation.exactKeys(
        value,
        [
            'causalRevision',
            'group',
            'members',
            'activeSessions',
            'memberCount',
            'onlineMemberCount'
        ],
        'GroupSnapshot'
    );
    validation.causalRevision(value.causalRevision, 'GroupSnapshot.causalRevision');
    if (validation.isRecord(value.causalRevision) && value.causalRevision.groupRevision === 0) {
        validation.integer(
            value.causalRevision.groupRevision,
            1,
            'GroupSnapshot.causalRevision.groupRevision'
        );
    }
    validateSnapshotGroup(value.group, value.causalRevision, { expected: scope, validation });
    const collections = validateSnapshotCollections(value, validation);
    validation.integer(value.memberCount, 0, 'GroupSnapshot.memberCount');
    validation.integer(value.onlineMemberCount, 0, 'GroupSnapshot.onlineMemberCount');
    validateSnapshotAggregates(value, collections, validation);
}

function validateSnapshotGroup<Value, CausalRevision>(
    value: Value,
    causal: CausalRevision,
    context: AuthoritativeGroupValidationContext
): void {
    const { validation } = context;
    if (!validation.isRecord(value)) {
        validation.record(value, 'GroupSnapshot.group');
        return;
    }
    validation.exactKeys(value, GROUP_KEYS, 'GroupSnapshot.group');
    validateGroupIdentity(value, 'GroupSnapshot.group', context);
    validateGroupMetadata(value, validation);
    validateGroupVersions(value, causal, validation);
    validateGroupLifecycle(value, validation);
    validateGroupFormation(value, validation);
}

function validateGroupIdentity(
    value: AuthoritativeStateRecord,
    path: string,
    context: AuthoritativeGroupValidationContext
): void {
    const { expected, validation } = context;
    validation.strings(value, ['applicationId', 'workspaceId', 'groupId'], path);
    if (
        expected &&
        (value.applicationId !== expected.applicationId || value.workspaceId !== expected.workspaceId)
    ) {
        validation.issue(path, `${path} is outside the requested scope`);
    }
}
function validateGroupMetadata(
    group: AuthoritativeStateRecord,
    validation: AuthoritativeStateValidation
): void {
    validation.enum(group.status, ['active', 'archived', 'deleted'], 'GroupSnapshot.group.status');
    validation.enum(group.kind, ['party', 'room', 'team', 'custom'], 'GroupSnapshot.group.kind');
    validation.enum(group.joinMode, ['invite-only', 'code', 'open'], 'GroupSnapshot.group.joinMode');
    validation.nullableStrings(group, ['slug', 'description'], 'GroupSnapshot.group');
    validation.strings(group, ['displayName', 'ownerPrincipalId'], 'GroupSnapshot.group');
    validation.nullablePositiveIntegers(
        group,
        ['maxMembers', 'maxSessionsPerMember'],
        'GroupSnapshot.group'
    );
    validation.record(group.metadata, 'GroupSnapshot.group.metadata');
    validation.integer(group.activeMemberCount, 0, 'GroupSnapshot.group.activeMemberCount');
}

function validateGroupVersions<CausalRevision>(
    group: AuthoritativeStateRecord,
    causal: CausalRevision,
    validation: AuthoritativeStateValidation
): void {
    validation.positiveIntegers(
        group,
        ['snapshotVersion', 'metadataVersion', 'rosterVersion'],
        'GroupSnapshot.group'
    );
    if (validation.isRecord(causal) && group.snapshotVersion !== causal.groupRevision) {
        validation.issue(
            'GroupSnapshot.group.snapshotVersion',
            'GroupSnapshot group snapshotVersion differs from causalRevision'
        );
    }
    validation.integer(group.presenceVersion, 0, 'GroupSnapshot.group.presenceVersion');
    if (validation.isRecord(causal) && group.presenceVersion !== causal.presenceRevision) {
        validation.issue(
            'GroupSnapshot.group.presenceVersion',
            'GroupSnapshot group presenceVersion differs from causalRevision'
        );
    }
}

function validateGroupLifecycle(
    group: AuthoritativeStateRecord,
    validation: AuthoritativeStateValidation
): void {
    validation.audits(group, ['created', 'updated'], 'GroupSnapshot.group');
    validation.nullableAudits(group, ['archived', 'deleted'], 'GroupSnapshot.group');
    if (
        group.status === 'active' && (group.archived !== null || group.deleted !== null) ||
        group.status === 'archived' && (group.archived === null || group.deleted !== null) ||
        group.status === 'deleted' && group.deleted === null
    ) {
        validation.issue('GroupSnapshot.group', 'GroupSnapshot group lifecycle is invalid');
    }
    validation.nullablePositiveIntegers(
        group,
        ['expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs'],
        'GroupSnapshot.group'
    );
}

function validateGroupFormation(
    group: AuthoritativeStateRecord,
    validation: AuthoritativeStateValidation
): void {
    validation.enum(
        group.lifecycleState,
        GROUP_LIFECYCLE_STATES,
        'GroupSnapshot.group.lifecycleState'
    );
    validation.nonNegativeIntegers(
        group,
        ['formationEpoch', 'formationAttemptCount'],
        'GroupSnapshot.group'
    );
    validateFormationOutcome(group.lastFormationOutcome, validation);
    validation.nullablePositiveInteger(
        group.establishmentStartedAtEpochMs,
        'GroupSnapshot.group.establishmentStartedAtEpochMs'
    );
    validateFormationElectorate(group.formationElectorate, validation);
    validateAcceptedLayout(group.acceptedLayoutIdentity, validation);
    validation.enum(
        group.transportState,
        GROUP_TRANSPORT_STATES,
        'GroupSnapshot.group.transportState'
    );
}

function validateFormationOutcome<Value>(
    value: Value,
    validation: AuthoritativeStateValidation
): void {
    const path = 'GroupSnapshot.group.lastFormationOutcome';
    if (value === null) {
        return;
    }
    if (!validation.isRecord(value)) {
        validation.record(value, path);
        return;
    }
    validation.exactKeys(value, ['outcome', 'observedRate', 'atEpochMs', 'formationEpoch'], path);
    validation.enum(
        value.outcome,
        ['activated', 'activated-degraded', 'below-floor'],
        `${path}.outcome`
    );
    if (
        typeof value.observedRate !== 'number' || !Number.isFinite(value.observedRate) ||
        value.observedRate < 0 || value.observedRate > 1
    ) {
        validation.issue(`${path}.observedRate`, `${path}.observedRate must be within [0, 1]`);
    }
    validation.integer(value.atEpochMs, 1, `${path}.atEpochMs`);
    validation.integer(value.formationEpoch, 0, `${path}.formationEpoch`);
}

function validateFormationElectorate<Value>(
    value: Value,
    validation: AuthoritativeStateValidation
): void {
    const path = 'GroupSnapshot.group.formationElectorate';
    if (!Array.isArray(value)) {
        validation.array(value, path);
        return;
    }
    if (new Set(value).size !== value.length) {
        validation.issue(path, `${path} must not repeat principal ids`);
    }
    for (let index = 0; index < value.length; index += 1) {
        const principalId = value[index];
        if (typeof principalId !== 'string' || principalId.length === 0) {
            validation.issue(`${path}[${index}]`, `${path} entries must be non-empty strings`);
        }
    }
}

function validateAcceptedLayout<Value>(
    value: Value,
    validation: AuthoritativeStateValidation
): void {
    const path = 'GroupSnapshot.group.acceptedLayoutIdentity';
    if (value === null) {
        return;
    }
    if (!validation.isRecord(value)) {
        validation.record(value, path);
        return;
    }
    validation.exactKeys(value, GROUP_LAYOUT_IDENTITY_KEYS, path);
    validation.nonNegativeIntegers(value, ['groupRevision', 'presenceRevision', 'version'], path);
    validation.enum(value.state, GROUP_LAYOUT_IDENTITY_STATES, `${path}.state`);
}

function validateSnapshotCollections(
    snapshot: AuthoritativeStateRecord,
    validation: AuthoritativeStateValidation
): GroupSnapshotCollections {
    const memberIds = new Set<string>();
    const activeMemberIds = new Set<string>();
    const activeOwnerIds = new Set<string>();
    validation.array(snapshot.members, 'GroupSnapshot.members');
    for (const [index, member] of (Array.isArray(snapshot.members) ? snapshot.members : []).entries()) {
        validateSnapshotMember(
            member,
            snapshot.group,
            validation.mapPath('GroupSnapshot.member', `GroupSnapshot.members[${index}]`)
        );
        if (!validation.isRecord(member) || typeof member.principalId !== 'string') {
            continue;
        }
        if (memberIds.has(member.principalId)) {
            validation.issue(`GroupSnapshot.members[${index}]`, 'GroupSnapshot has duplicate members');
        }
        memberIds.add(member.principalId);
        if (member.status === 'active') {
            activeMemberIds.add(member.principalId);
            if (member.role === 'owner') {
                activeOwnerIds.add(member.principalId);
            }
        }
    }
    const sessions = validateSnapshotSessions(snapshot, activeMemberIds, validation);
    return { activeMemberIds, activeOwnerIds, ...sessions };
}

function validateSnapshotMember<Value, Group>(
    value: Value,
    group: Group,
    validation: AuthoritativeStateValidation
): void {
    const path = 'GroupSnapshot.member';
    if (!validation.isRecord(value)) {
        validation.record(value, path);
        return;
    }
    const expectedTerminal = ['left', 'removed', 'banned'].find((status) => status === value.status);
    validation.exactKeys(value, GROUP_MEMBER_KEYS, path);
    validateSameGroup(value, { group, path, validation });
    validation.strings(value, ['principalId'], path);
    validation.enum(value.role, ['owner', 'admin', 'member'], `${path}.role`);
    validation.enum(
        value.status,
        ['invited', 'pending', 'active', 'left', 'removed', 'banned'],
        `${path}.status`
    );
    validation.nullableAudits(value, ['joined', 'left', 'removed', 'banned'], path);
    validation.audits(value, ['updated'], path);
    validation.nullableStrings(value, ['invitedByPrincipalId'], path);
    validation.nullablePositiveInteger(value.invitationExpiresAtEpochMs, `${path}.invitationExpiresAtEpochMs`);
    if ((value.status === 'invited' || value.status === 'pending') && value.joined !== null) {
        validation.issue(`${path}.joined`, 'GroupSnapshot invited/pending member joined must be null');
    }
    if (value.status === 'active' && value.joined === null) {
        validation.issue(`${path}.joined`, 'GroupSnapshot active member joined is required');
    }
    for (const terminal of ['left', 'removed', 'banned']) {
        if ((terminal === expectedTerminal) !== (value[terminal] !== null)) {
            validation.issue(`${path}.${terminal}`, 'GroupSnapshot member terminal lifecycle is invalid');
        }
    }
}

function validateSnapshotSessions(
    snapshot: AuthoritativeStateRecord,
    activeMemberIds: ReadonlySet<string>,
    validation: AuthoritativeStateValidation
): Pick<GroupSnapshotCollections, 'onlinePrincipalIds' | 'sessionCount'> {
    const sessions = Array.isArray(snapshot.activeSessions) ? snapshot.activeSessions : [];
    const sessionIds = new Set<string>();
    const onlinePrincipalIds = new Set<string>();
    validation.array(snapshot.activeSessions, 'GroupSnapshot.activeSessions');
    for (const [index, session] of sessions.entries()) {
        validateSnapshotSession(
            session,
            { group: snapshot.group, activeMemberIds, sessionIds },
            validation.mapPath('GroupSnapshot.session', `GroupSnapshot.activeSessions[${index}]`)
        );
        if (validation.isRecord(session)) {
            if (typeof session.sessionId === 'string') {
                sessionIds.add(session.sessionId);
            }
            if (typeof session.principalId === 'string') {
                onlinePrincipalIds.add(session.principalId);
            }
        }
    }
    return { onlinePrincipalIds, sessionCount: sessions.length };
}

function validateSnapshotSession<Value>(
    value: Value,
    predecessor: GroupSnapshotSessionPredecessor,
    validation: AuthoritativeStateValidation
): void {
    const path = 'GroupSnapshot.session';
    if (!validation.isRecord(value)) {
        validation.record(value, path);
        return;
    }
    validation.exactKeys(value, GROUP_SESSION_KEYS, path);
    validateSameGroup(value, { group: predecessor.group, path, validation });
    validation.strings(value, ['sessionId', 'principalId', 'generationId'], path);
    if (typeof value.sessionId === 'string' && predecessor.sessionIds.has(value.sessionId)) {
        validation.issue(path, 'GroupSnapshot has duplicate active sessions');
    }
    if (typeof value.principalId === 'string' && !predecessor.activeMemberIds.has(value.principalId)) {
        validation.issue(path, 'GroupSnapshot active session principal is not an active member');
    }
    validation.positiveIntegers(
        value,
        ['generationVersion', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'],
        path
    );
    if (
        typeof value.connectedAtEpochMs === 'number' && typeof value.lastHeartbeatAtEpochMs === 'number' &&
        typeof value.expiresAtEpochMs === 'number' &&
        (value.lastHeartbeatAtEpochMs < value.connectedAtEpochMs ||
            value.expiresAtEpochMs < value.lastHeartbeatAtEpochMs)
    ) {
        validation.issue(path, 'GroupSnapshot active session timestamps are causally inconsistent');
    }
    if (value.status !== 'active' || value.disconnectedAtEpochMs !== null || value.disconnectReason !== null) {
        validation.issue(path, 'GroupSnapshot active session lifecycle is invalid');
    }
}

function validateSnapshotAggregates(
    snapshot: AuthoritativeStateRecord,
    collections: GroupSnapshotCollections,
    validation: AuthoritativeStateValidation
): void {
    const group = snapshot.group;
    if (!validation.isRecord(group)) {
        return;
    }
    if (
        snapshot.memberCount !== collections.activeMemberIds.size ||
        group.activeMemberCount !== collections.activeMemberIds.size ||
        collections.activeOwnerIds.size !== 1 || typeof group.ownerPrincipalId !== 'string' ||
        !collections.activeOwnerIds.has(group.ownerPrincipalId) ||
        snapshot.onlineMemberCount !== collections.onlinePrincipalIds.size ||
        typeof snapshot.onlineMemberCount === 'number' && typeof snapshot.memberCount === 'number' &&
            snapshot.onlineMemberCount > snapshot.memberCount
    ) {
        validation.issue('GroupSnapshot', 'GroupSnapshot aggregate counts are inconsistent');
    }
    if (
        typeof group.maxMembers === 'number' && typeof group.activeMemberCount === 'number' &&
        group.activeMemberCount > group.maxMembers
    ) {
        validation.issue(
            'GroupSnapshot.group.activeMemberCount',
            'GroupSnapshot activeMemberCount exceeds maxMembers'
        );
    }
    if (group.status !== 'active' && collections.sessionCount !== 0) {
        validation.issue('GroupSnapshot.activeSessions', 'GroupSnapshot inactive group has active presence');
    }
}

function validateSameGroup(
    value: AuthoritativeStateRecord,
    relationship: GroupRelationshipValidation
): void {
    const { group, path, validation } = relationship;
    if (
        validation.isRecord(group) &&
        ['applicationId', 'workspaceId', 'groupId'].some((key) => value[key] !== group[key])
    ) {
        validation.issue(path, `${path} scope is inconsistent`);
    }
}

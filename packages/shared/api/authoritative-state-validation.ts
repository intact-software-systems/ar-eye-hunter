import type {
    ClientSnapshot,
} from './client-types.ts';
import { toGroupSnapshotStateRevision } from './group-client-views.ts';
import type { GroupRef, GroupSnapshot } from './group-types.ts';
import type { RallarOverlayTopologySnapshot } from './overlay-topology.ts';
import type { StateScope } from './state-types.ts';

const AUDIT_KEYS = ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'];
const CLIENT_PRINCIPAL_KEYS = [
    'applicationId', 'workspaceId', 'principalId', 'username', 'displayName',
    'avatarUrl', 'authProvider', 'externalSubjectId', 'status', 'disabled',
    'deleted', 'roles', 'metadata', 'snapshotVersion', 'profileVersion',
    'presenceVersion', 'created', 'updated', 'lastSeenAtEpochMs',
];
const CLIENT_INSTANCE_KEYS = [
    'applicationId', 'workspaceId', 'principalId', 'clientInstanceId', 'status',
    'platform', 'deviceLabel', 'appVersion', 'userAgent', 'capabilities',
    'registered', 'updated', 'revoked',
];
const CLIENT_SESSION_KEYS = [
    'applicationId', 'workspaceId', 'principalId', 'clientInstanceId', 'sessionId',
    'generationId', 'generationVersion', 'status', 'presenceState', 'transport',
    'connectionId', 'authenticatedAtEpochMs', 'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs', 'expiresAtEpochMs', 'disconnectedAtEpochMs',
    'disconnectReason',
];
const GROUP_KEYS = [
    'applicationId', 'workspaceId', 'groupId', 'slug', 'displayName',
    'description', 'kind', 'status', 'joinMode', 'maxMembers',
    'maxSessionsPerMember', 'metadata', 'activeMemberCount', 'ownerPrincipalId',
    'snapshotVersion', 'metadataVersion', 'rosterVersion', 'presenceVersion',
    'created', 'updated', 'archived', 'deleted', 'expiresAtEpochMs',
    'emptySinceEpochMs', 'purgeAfterEpochMs',
];
const GROUP_MEMBER_KEYS = [
    'applicationId', 'workspaceId', 'groupId', 'principalId', 'role', 'status',
    'joined', 'updated', 'left', 'removed', 'banned', 'invitedByPrincipalId',
    'invitationExpiresAtEpochMs',
];
const GROUP_SESSION_KEYS = [
    'applicationId', 'workspaceId', 'groupId', 'sessionId', 'principalId',
    'generationId', 'generationVersion', 'status', 'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs', 'expiresAtEpochMs', 'disconnectedAtEpochMs',
    'disconnectReason',
];

export function parseAuthoritativeClientSnapshot(
    serialized: string,
    scope?: StateScope,
): ClientSnapshot {
    const value: unknown = JSON.parse(serialized);
    validateAuthoritativeClientSnapshot(value, scope);
    return value;
}

export function parseAuthoritativeGroupSnapshot(
    serialized: string,
    scope?: StateScope,
): GroupSnapshot {
    const value: unknown = JSON.parse(serialized);
    validateAuthoritativeGroupSnapshot(value, scope);
    return value;
}

export function parseAuthoritativeOverlayTopologySnapshot(
    serialized: string,
    scope?: StateScope,
): RallarOverlayTopologySnapshot {
    const value: unknown = JSON.parse(serialized);
    validateAuthoritativeOverlayTopologySnapshot(value, scope);
    return value;
}

export function validateAuthoritativeClientSnapshot(
    value: unknown,
    scope?: StateScope,
): asserts value is ClientSnapshot {
    const snapshot = record(value, 'ClientSnapshot');
    exact(snapshot, [
        'stateRevision', 'principal', 'instances', 'activeSessions', 'isOnline',
        'activeSessionCount', 'lastSeenAtEpochMs',
    ], 'ClientSnapshot');
    nonNegativeInteger(snapshot.stateRevision, 'ClientSnapshot.stateRevision');
    const principal = record(snapshot.principal, 'ClientSnapshot.principal');
    exact(principal, CLIENT_PRINCIPAL_KEYS, 'ClientSnapshot.principal');
    const ref = clientRef(principal, 'ClientSnapshot.principal', scope);
    enumValue(principal.status, ['active', 'disabled', 'deleted'],
        'ClientSnapshot.principal.status');
    nonEmptyString(principal.username, 'ClientSnapshot.principal.username');
    stringArray(principal.roles, 'ClientSnapshot.principal.roles');
    record(principal.metadata, 'ClientSnapshot.principal.metadata');
    validateAudit(principal.created, 'ClientSnapshot.principal.created');
    validateAudit(principal.updated, 'ClientSnapshot.principal.updated');
    nullableAudit(principal.disabled, 'ClientSnapshot.principal.disabled');
    nullableAudit(principal.deleted, 'ClientSnapshot.principal.deleted');
    if (principal.status === 'active' &&
        (principal.disabled !== null || principal.deleted !== null)) {
        fail('ClientSnapshot principal lifecycle is invalid');
    }
    if (principal.status === 'disabled' &&
        (principal.disabled === null || principal.deleted !== null)) {
        fail('ClientSnapshot principal lifecycle is invalid');
    }
    if (principal.status === 'deleted' && principal.deleted === null) {
        fail('ClientSnapshot principal lifecycle is invalid');
    }
    const instances = array(snapshot.instances, 'ClientSnapshot.instances');
    for (const item of instances) {
        const instance = record(item, 'ClientSnapshot.instance');
        exact(instance, CLIENT_INSTANCE_KEYS, 'ClientSnapshot.instance');
        sameClientRef(instance, ref, 'ClientSnapshot.instance');
        nonEmptyString(
            instance.clientInstanceId,
            'ClientSnapshot.instance.clientInstanceId',
        );
        enumValue(instance.status, ['active', 'revoked', 'retired'],
            'ClientSnapshot.instance.status');
        enumValue(instance.platform, [
            'web', 'ios', 'android', 'desktop', 'server', 'unknown',
        ], 'ClientSnapshot.instance.platform');
        stringArray(instance.capabilities, 'ClientSnapshot.instance.capabilities');
        validateAudit(instance.registered, 'ClientSnapshot.instance.registered');
        validateAudit(instance.updated, 'ClientSnapshot.instance.updated');
        nullableAudit(instance.revoked, 'ClientSnapshot.instance.revoked');
        if ((instance.status === 'active') !== (instance.revoked === null)) {
            fail('ClientSnapshot instance lifecycle is invalid');
        }
    }
    const sessions = array(snapshot.activeSessions, 'ClientSnapshot.activeSessions');
    for (const item of sessions) {
        const session = record(item, 'ClientSnapshot.session');
        exact(session, CLIENT_SESSION_KEYS, 'ClientSnapshot.session');
        sameClientRef(session, ref, 'ClientSnapshot.session');
        for (const key of [
            'clientInstanceId', 'sessionId', 'generationId',
        ] as const) nonEmptyString(session[key], `ClientSnapshot.session.${key}`);
        enumValue(session.presenceState, ['online', 'offline', 'away', 'busy'],
            'ClientSnapshot.session.presenceState');
        enumValue(session.transport, ['ws', 'http', 'rtc', 'unknown'],
            'ClientSnapshot.session.transport');
        if (session.status !== 'active' || session.disconnectedAtEpochMs !== null ||
            session.disconnectReason !== null) {
            fail('ClientSnapshot active session lifecycle is invalid');
        }
    }
    nonNegativeInteger(snapshot.activeSessionCount, 'ClientSnapshot.activeSessionCount');
    if (snapshot.activeSessionCount !== sessions.length) {
        fail('ClientSnapshot activeSessionCount is inconsistent');
    }
    if (typeof snapshot.isOnline !== 'boolean') fail('ClientSnapshot.isOnline is invalid');
    if (snapshot.isOnline !== (sessions.length > 0)) {
        fail('ClientSnapshot isOnline is inconsistent');
    }
}

export function validateAuthoritativeGroupSnapshot(
    value: unknown,
    scope?: StateScope,
): asserts value is GroupSnapshot {
    const snapshot = record(value, 'GroupSnapshot');
    exact(snapshot, [
        'stateRevision', 'causalRevision', 'group', 'members', 'activeSessions',
        'memberCount', 'onlineMemberCount',
    ], 'GroupSnapshot');
    const causal = causalRevision(snapshot.causalRevision, 'GroupSnapshot.causalRevision');
    nonNegativeInteger(snapshot.stateRevision, 'GroupSnapshot.stateRevision');
    if (snapshot.stateRevision !== toGroupSnapshotStateRevision(
        causal.groupRevision,
        causal.presenceRevision,
    )) fail('GroupSnapshot.stateRevision differs from causalRevision');
    const group = record(snapshot.group, 'GroupSnapshot.group');
    exact(group, GROUP_KEYS, 'GroupSnapshot.group');
    const ref = groupRef(group, 'GroupSnapshot.group', scope);
    enumValue(group.status, ['active', 'archived', 'deleted'],
        'GroupSnapshot.group.status');
    enumValue(group.kind, ['party', 'room', 'team', 'custom'],
        'GroupSnapshot.group.kind');
    enumValue(group.joinMode, ['invite-only', 'code', 'open'],
        'GroupSnapshot.group.joinMode');
    nonEmptyString(group.displayName, 'GroupSnapshot.group.displayName');
    nonEmptyString(group.ownerPrincipalId, 'GroupSnapshot.group.ownerPrincipalId');
    record(group.metadata, 'GroupSnapshot.group.metadata');
    nonNegativeInteger(group.activeMemberCount, 'GroupSnapshot.group.activeMemberCount');
    nonNegativeInteger(group.presenceVersion, 'GroupSnapshot.group.presenceVersion');
    if (group.presenceVersion !== causal.presenceRevision) {
        fail('GroupSnapshot group presenceVersion differs from causalRevision');
    }
    validateAudit(group.created, 'GroupSnapshot.group.created');
    validateAudit(group.updated, 'GroupSnapshot.group.updated');
    nullableAudit(group.archived, 'GroupSnapshot.group.archived');
    nullableAudit(group.deleted, 'GroupSnapshot.group.deleted');
    if (group.status === 'active' && (group.archived !== null || group.deleted !== null)) {
        fail('GroupSnapshot group lifecycle is invalid');
    }
    if (group.status === 'archived' && (group.archived === null || group.deleted !== null)) {
        fail('GroupSnapshot group lifecycle is invalid');
    }
    if (group.status === 'deleted' && group.deleted === null) {
        fail('GroupSnapshot group lifecycle is invalid');
    }
    const members = array(snapshot.members, 'GroupSnapshot.members');
    for (const item of members) validateGroupMember(item, ref);
    const sessions = array(snapshot.activeSessions, 'GroupSnapshot.activeSessions');
    const onlinePrincipalIds = new Set<string>();
    for (const item of sessions) {
        const session = record(item, 'GroupSnapshot.session');
        exact(session, GROUP_SESSION_KEYS, 'GroupSnapshot.session');
        sameGroupRef(session, ref, 'GroupSnapshot.session');
        for (const key of [
            'sessionId', 'principalId', 'generationId',
        ] as const) nonEmptyString(session[key], `GroupSnapshot.session.${key}`);
        nonEmptyString(session.principalId, 'GroupSnapshot.session.principalId');
        if (session.status !== 'active' || session.disconnectedAtEpochMs !== null ||
            session.disconnectReason !== null) {
            fail('GroupSnapshot active session lifecycle is invalid');
        }
        onlinePrincipalIds.add(session.principalId);
    }
    nonNegativeInteger(snapshot.memberCount, 'GroupSnapshot.memberCount');
    nonNegativeInteger(snapshot.onlineMemberCount, 'GroupSnapshot.onlineMemberCount');
    const activeMemberCount = members.filter((item) =>
        isRecord(item) && item.status === 'active'
    ).length;
    if (snapshot.memberCount !== activeMemberCount ||
        group.activeMemberCount !== activeMemberCount ||
        snapshot.onlineMemberCount !== onlinePrincipalIds.size) {
        fail('GroupSnapshot aggregate counts are inconsistent');
    }
}

export function validateAuthoritativeOverlayTopologySnapshot(
    value: unknown,
    scope?: StateScope,
): asserts value is RallarOverlayTopologySnapshot {
    const topology = record(value, 'RallarOverlayTopologySnapshot');
    exact(topology, [
        'sourceGroupStateCausalRevision', 'state', 'overlayId', 'groupRef', 'name',
        'topology', 'activeSessionIds', 'nextHopsBySessionId', 'degreeLimit',
        'version', 'createdByClientId', 'createdAtEpochMs', 'updatedAtEpochMs',
    ], 'RallarOverlayTopologySnapshot');
    causalRevision(
        topology.sourceGroupStateCausalRevision,
        'RallarOverlayTopologySnapshot.sourceGroupStateCausalRevision',
    );
    groupRef(
        record(topology.groupRef, 'RallarOverlayTopologySnapshot.groupRef'),
        'RallarOverlayTopologySnapshot.groupRef',
        scope,
        true,
    );
    if (topology.state !== 'active' && topology.state !== 'removed') {
        fail('RallarOverlayTopologySnapshot.state is invalid');
    }
    nonEmptyString(topology.overlayId, 'RallarOverlayTopologySnapshot.overlayId');
    nonEmptyString(topology.name, 'RallarOverlayTopologySnapshot.name');
    enumValue(topology.topology, ['star', 'tree', 'mesh'],
        'RallarOverlayTopologySnapshot.topology');
    nonEmptyString(
        topology.createdByClientId,
        'RallarOverlayTopologySnapshot.createdByClientId',
    );
    const activeSessionIds = stringArray(
        topology.activeSessionIds,
        'RallarOverlayTopologySnapshot.activeSessionIds',
    );
    const nextHops = record(
        topology.nextHopsBySessionId,
        'RallarOverlayTopologySnapshot.nextHopsBySessionId',
    );
    if (Object.keys(nextHops).some((sessionId) => !activeSessionIds.includes(sessionId))) {
        fail('RallarOverlayTopologySnapshot next-hop key is not active');
    }
    for (const [sessionId, peers] of Object.entries(nextHops)) {
        const peerIds = stringArray(
            peers,
            `RallarOverlayTopologySnapshot.nextHopsBySessionId.${sessionId}`,
        );
        if (peerIds.some((peerId) => !activeSessionIds.includes(peerId))) {
            fail('RallarOverlayTopologySnapshot next hop is not active');
        }
    }
    positiveInteger(topology.degreeLimit, 'RallarOverlayTopologySnapshot.degreeLimit');
    nonNegativeInteger(topology.version, 'RallarOverlayTopologySnapshot.version');
    nonNegativeInteger(
        topology.createdAtEpochMs,
        'RallarOverlayTopologySnapshot.createdAtEpochMs',
    );
    nonNegativeInteger(
        topology.updatedAtEpochMs,
        'RallarOverlayTopologySnapshot.updatedAtEpochMs',
    );
}

export function validateAuthoritativeClientSnapshotList(
    value: unknown,
    scope: StateScope,
): asserts value is ClientSnapshot[] {
    const snapshots = array(value, 'ClientSnapshot list');
    for (const snapshot of snapshots) validateAuthoritativeClientSnapshot(snapshot, scope);
}

export function validateAuthoritativeGroupSnapshotList(
    value: unknown,
    scope: StateScope,
): asserts value is GroupSnapshot[] {
    const snapshots = array(value, 'GroupSnapshot list');
    for (const snapshot of snapshots) validateAuthoritativeGroupSnapshot(snapshot, scope);
}

function validateGroupMember(value: unknown, ref: GroupRef): void {
    const member = record(value, 'GroupSnapshot.member');
    exact(member, GROUP_MEMBER_KEYS, 'GroupSnapshot.member');
    sameGroupRef(member, ref, 'GroupSnapshot.member');
    nonEmptyString(member.principalId, 'GroupSnapshot.member.principalId');
    enumValue(member.role, ['owner', 'admin', 'member'], 'GroupSnapshot.member.role');
    enumValue(member.status, ['invited', 'active', 'left', 'removed', 'banned'],
        'GroupSnapshot.member.status');
    nullableAudit(member.joined, 'GroupSnapshot.member.joined');
    validateAudit(member.updated, 'GroupSnapshot.member.updated');
    nullableAudit(member.left, 'GroupSnapshot.member.left');
    nullableAudit(member.removed, 'GroupSnapshot.member.removed');
    nullableAudit(member.banned, 'GroupSnapshot.member.banned');
    if (member.status === 'invited' && member.joined !== null) {
        fail('GroupSnapshot invited member joined must be null');
    }
    if (member.status === 'active' && member.joined === null) {
        fail('GroupSnapshot active member joined is required');
    }
    const terminal = member.status === 'left'
        ? member.left
        : member.status === 'removed'
        ? member.removed
        : member.status === 'banned'
        ? member.banned
        : null;
    if (['left', 'removed', 'banned'].includes(String(member.status)) && terminal === null) {
        fail('GroupSnapshot member terminal lifecycle is invalid');
    }
}

function validateAudit(value: unknown, label: string): void {
    const audit = record(value, label);
    exact(audit, AUDIT_KEYS, label);
    nonNegativeInteger(audit.atEpochMs, `${label}.atEpochMs`);
    const actor = record(audit.actor, `${label}.actor`);
    if (actor.kind === 'principal') exact(actor, ['kind', 'principalId'], `${label}.actor`);
    else if (actor.kind === 'session') {
        exact(actor, ['kind', 'sessionId', 'principalId'], `${label}.actor`);
    } else if (actor.kind === 'service') exact(actor, ['kind', 'serviceId'], `${label}.actor`);
    else fail(`${label}.actor.kind is invalid`);
    nullableString(audit.reason, `${label}.reason`);
    nullableString(audit.traceId, `${label}.traceId`);
    nullableString(audit.requestId, `${label}.requestId`);
}

function nullableAudit(value: unknown, label: string): void {
    if (value !== null) validateAudit(value, label);
}

function clientRef(
    value: Record<string, unknown>,
    label: string,
    scope?: StateScope,
): Readonly<{ applicationId: string; workspaceId: string; principalId: string }> {
    nonEmptyString(value.applicationId, `${label}.applicationId`);
    nonEmptyString(value.workspaceId, `${label}.workspaceId`);
    nonEmptyString(value.principalId, `${label}.principalId`);
    requireScope(value, scope, label);
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        principalId: value.principalId,
    };
}

function groupRef(
    value: Record<string, unknown>,
    label: string,
    scope?: StateScope,
    exactObject = false,
): GroupRef {
    exact(value, ['applicationId', 'workspaceId', 'groupId'], label, exactObject);
    nonEmptyString(value.applicationId, `${label}.applicationId`);
    nonEmptyString(value.workspaceId, `${label}.workspaceId`);
    nonEmptyString(value.groupId, `${label}.groupId`);
    requireScope(value, scope, label);
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId,
    };
}

function sameClientRef(
    value: Record<string, unknown>,
    ref: Readonly<{ applicationId: string; workspaceId: string; principalId: string }>,
    label: string,
): void {
    if (value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId || value.principalId !== ref.principalId) {
        fail(`${label} scope is inconsistent`);
    }
}

function sameGroupRef(value: Record<string, unknown>, ref: GroupRef, label: string): void {
    if (value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId || value.groupId !== ref.groupId) {
        fail(`${label} scope is inconsistent`);
    }
}

function requireScope(
    value: Record<string, unknown>,
    scope: StateScope | undefined,
    label: string,
): void {
    if (scope && (value.applicationId !== scope.applicationId ||
        value.workspaceId !== scope.workspaceId)) fail(`${label} is outside the requested scope`);
}

function causalRevision(
    value: unknown,
    label: string,
): Readonly<{ groupRevision: number; presenceRevision: number }> {
    const causal = record(value, label);
    exact(causal, ['groupRevision', 'presenceRevision'], label);
    nonNegativeInteger(causal.groupRevision, `${label}.groupRevision`);
    nonNegativeInteger(causal.presenceRevision, `${label}.presenceRevision`);
    return {
        groupRevision: causal.groupRevision,
        presenceRevision: causal.presenceRevision,
    };
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) fail(`${label} must be an object`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    return value;
}

function stringArray(value: unknown, label: string): string[] {
    const values = array(value, label);
    const strings: string[] = [];
    for (const item of values) {
        nonEmptyString(item, `${label} item`);
        strings.push(item);
    }
    return strings;
}

function enumValue(value: unknown, allowed: readonly string[], label: string): void {
    if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is invalid`);
}

function exact(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string,
    rejectExtras = true,
): void {
    const missing = keys.find((key) => !Object.hasOwn(value, key));
    if (missing) fail(`${label} is missing ${missing}`);
    if (rejectExtras) {
        const allowed = new Set(keys);
        const extra = Object.keys(value).find((key) => !allowed.has(key));
        if (extra) fail(`${label} has unexpected ${extra}`);
    }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) fail(`${label} is invalid`);
}

function nullableString(value: unknown, label: string): void {
    if (value !== null) nonEmptyString(value, label);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} is invalid`);
}

function positiveInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} is invalid`);
}

function fail(message: string): never {
    throw new TypeError(message);
}

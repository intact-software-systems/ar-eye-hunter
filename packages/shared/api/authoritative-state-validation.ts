import { toScopedOverlayId } from './api-type-utils.ts';
import type { ClientEvent, ClientSnapshot } from './client-types.ts';
import { toClientSnapshotLastSeenAtEpochMs } from './group-client-views.ts';
import type { GroupEvent, GroupRef, GroupSnapshot } from './group-types.ts';
import type { RallarOverlayTopologySnapshot } from './overlay-topology.ts';
import type { StateEventPage } from './state-event-types.ts';
import type { StateScope } from './state-types.ts';

const AUDIT_KEYS = ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'];
const CLIENT_PRINCIPAL_KEYS = [
    'applicationId',
    'workspaceId',
    'principalId',
    'username',
    'displayName',
    'avatarUrl',
    'authProvider',
    'externalSubjectId',
    'status',
    'disabled',
    'deleted',
    'roles',
    'metadata',
    'snapshotVersion',
    'profileVersion',
    'presenceVersion',
    'created',
    'updated',
    'lastSeenAtEpochMs'
];
const CLIENT_INSTANCE_KEYS = [
    'applicationId',
    'workspaceId',
    'principalId',
    'clientInstanceId',
    'status',
    'platform',
    'deviceLabel',
    'appVersion',
    'userAgent',
    'capabilities',
    'registered',
    'updated',
    'revoked'
];
const CLIENT_SESSION_KEYS = [
    'applicationId',
    'workspaceId',
    'principalId',
    'clientInstanceId',
    'sessionId',
    'generationId',
    'generationVersion',
    'status',
    'presenceState',
    'transport',
    'connectionId',
    'authenticatedAtEpochMs',
    'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
    'disconnectedAtEpochMs',
    'disconnectReason'
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
    'formationElectorate'
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
const CLIENT_EVENT_KEYS = [
    'applicationId',
    'workspaceId',
    'principalId',
    'eventId',
    'eventType',
    'snapshotVersion',
    'clientInstanceId',
    'sessionId',
    'occurredAtEpochMs',
    'actor',
    'reason',
    'traceId',
    'requestId',
    'payload'
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
const CLIENT_EVENT_TYPES = [
    'principal-created',
    'principal-updated',
    'principal-disabled',
    'principal-deleted',
    'instance-registered',
    'instance-updated',
    'instance-revoked',
    'session-authenticated',
    'session-connected',
    'session-heartbeat',
    'session-disconnected',
    'session-expired'
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

export function parseAuthoritativeClientSnapshot(
    serialized: string,
    scope?: StateScope
): ClientSnapshot {
    const value: unknown = JSON.parse(serialized);
    validateAuthoritativeClientSnapshot(value, scope);
    return value;
}

export function parseAuthoritativeGroupSnapshot(
    serialized: string,
    scope?: StateScope
): GroupSnapshot {
    const value: unknown = JSON.parse(serialized);
    validateAuthoritativeGroupSnapshot(value, scope);
    return value;
}

export function parseAuthoritativeOverlayTopologySnapshot(
    serialized: string,
    scope?: StateScope
): RallarOverlayTopologySnapshot {
    const value: unknown = JSON.parse(serialized);
    validateAuthoritativeOverlayTopologySnapshot(value, scope);
    return value;
}

export function validateAuthoritativeClientSnapshot(
    value: unknown,
    scope?: StateScope
): asserts value is ClientSnapshot {
    const snapshot = record(value, 'ClientSnapshot');
    exact(
        snapshot,
        [
            'stateRevision',
            'principal',
            'instances',
            'activeSessions',
            'isOnline',
            'activeSessionCount',
            'lastSeenAtEpochMs'
        ],
        'ClientSnapshot'
    );
    nonNegativeInteger(snapshot.stateRevision, 'ClientSnapshot.stateRevision');
    const principal = record(snapshot.principal, 'ClientSnapshot.principal');
    exact(principal, CLIENT_PRINCIPAL_KEYS, 'ClientSnapshot.principal');
    const ref = clientRef(principal, 'ClientSnapshot.principal', scope);
    enumValue(principal.status, ['active', 'disabled', 'deleted'], 'ClientSnapshot.principal.status');
    nonEmptyString(principal.username, 'ClientSnapshot.principal.username');
    for (const key of ['displayName', 'avatarUrl', 'authProvider', 'externalSubjectId'] as const) {
        nullableString(principal[key], `ClientSnapshot.principal.${key}`);
    }
    stringArray(principal.roles, 'ClientSnapshot.principal.roles');
    record(principal.metadata, 'ClientSnapshot.principal.metadata');
    for (const key of ['snapshotVersion', 'profileVersion', 'presenceVersion'] as const) {
        positiveInteger(principal[key], `ClientSnapshot.principal.${key}`);
    }
    validateAudit(principal.created, 'ClientSnapshot.principal.created');
    validateAudit(principal.updated, 'ClientSnapshot.principal.updated');
    nullableAudit(principal.disabled, 'ClientSnapshot.principal.disabled');
    nullableAudit(principal.deleted, 'ClientSnapshot.principal.deleted');
    if (
        principal.status === 'active' &&
        (principal.disabled !== null || principal.deleted !== null)
    ) {
        fail('ClientSnapshot principal lifecycle is invalid');
    }
    if (
        principal.status === 'disabled' &&
        (principal.disabled === null || principal.deleted !== null)
    ) {
        fail('ClientSnapshot principal lifecycle is invalid');
    }
    if (principal.status === 'deleted' && principal.deleted === null) {
        fail('ClientSnapshot principal lifecycle is invalid');
    }
    const principalLastSeenAtEpochMs = principal.lastSeenAtEpochMs;
    nullableNonNegativeInteger(
        principalLastSeenAtEpochMs,
        'ClientSnapshot.principal.lastSeenAtEpochMs'
    );
    const instances = array(snapshot.instances, 'ClientSnapshot.instances');
    const instanceIds = new Set<string>();
    for (const item of instances) {
        const instance = record(item, 'ClientSnapshot.instance');
        exact(instance, CLIENT_INSTANCE_KEYS, 'ClientSnapshot.instance');
        sameClientRef(instance, ref, 'ClientSnapshot.instance');
        nonEmptyString(instance.clientInstanceId, 'ClientSnapshot.instance.clientInstanceId');
        if (instanceIds.has(instance.clientInstanceId)) {
            fail('ClientSnapshot has duplicate instances');
        }
        instanceIds.add(instance.clientInstanceId);
        enumValue(instance.status, ['active', 'revoked', 'retired'], 'ClientSnapshot.instance.status');
        enumValue(
            instance.platform,
            ['web', 'ios', 'android', 'desktop', 'server', 'unknown'],
            'ClientSnapshot.instance.platform'
        );
        for (const key of ['deviceLabel', 'appVersion', 'userAgent'] as const) {
            nullableString(instance[key], `ClientSnapshot.instance.${key}`);
        }
        stringArray(instance.capabilities, 'ClientSnapshot.instance.capabilities');
        validateAudit(instance.registered, 'ClientSnapshot.instance.registered');
        validateAudit(instance.updated, 'ClientSnapshot.instance.updated');
        nullableAudit(instance.revoked, 'ClientSnapshot.instance.revoked');
        if ((instance.status === 'active') !== (instance.revoked === null)) {
            fail('ClientSnapshot instance lifecycle is invalid');
        }
    }
    const sessions = array(snapshot.activeSessions, 'ClientSnapshot.activeSessions');
    const sessionIds = new Set<string>();
    const activeSessionHeartbeats: Array<{ lastHeartbeatAtEpochMs: number; }> = [];
    for (const item of sessions) {
        const session = record(item, 'ClientSnapshot.session');
        exact(session, CLIENT_SESSION_KEYS, 'ClientSnapshot.session');
        sameClientRef(session, ref, 'ClientSnapshot.session');
        nonEmptyString(session.clientInstanceId, 'ClientSnapshot.session.clientInstanceId');
        nonEmptyString(session.sessionId, 'ClientSnapshot.session.sessionId');
        nonEmptyString(session.generationId, 'ClientSnapshot.session.generationId');
        if (sessionIds.has(session.sessionId)) {
            fail('ClientSnapshot has duplicate active sessions');
        }
        sessionIds.add(session.sessionId);
        if (!instanceIds.has(session.clientInstanceId)) {
            fail('ClientSnapshot active session instance is missing');
        }
        positiveInteger(session.generationVersion, 'ClientSnapshot.session.generationVersion');
        enumValue(
            session.presenceState,
            ['online', 'offline', 'away', 'busy'],
            'ClientSnapshot.session.presenceState'
        );
        enumValue(
            session.transport,
            ['ws', 'http', 'rtc', 'unknown'],
            'ClientSnapshot.session.transport'
        );
        nullableString(session.connectionId, 'ClientSnapshot.session.connectionId');
        const authenticatedAt = session.authenticatedAtEpochMs;
        const connectedAt = session.connectedAtEpochMs;
        const heartbeatAt = session.lastHeartbeatAtEpochMs;
        const expiresAt = session.expiresAtEpochMs;
        nonNegativeInteger(authenticatedAt, 'ClientSnapshot.session.authenticatedAtEpochMs');
        nonNegativeInteger(connectedAt, 'ClientSnapshot.session.connectedAtEpochMs');
        nonNegativeInteger(heartbeatAt, 'ClientSnapshot.session.lastHeartbeatAtEpochMs');
        nonNegativeInteger(expiresAt, 'ClientSnapshot.session.expiresAtEpochMs');
        if (
            session.status !== 'active' ||
            session.disconnectedAtEpochMs !== null ||
            session.disconnectReason !== null
        ) {
            fail('ClientSnapshot active session lifecycle is invalid');
        }
        if (authenticatedAt > connectedAt || connectedAt > heartbeatAt || heartbeatAt > expiresAt) {
            fail('ClientSnapshot active session timestamps are causally inconsistent');
        }
        activeSessionHeartbeats.push({ lastHeartbeatAtEpochMs: heartbeatAt });
    }
    nonNegativeInteger(snapshot.activeSessionCount, 'ClientSnapshot.activeSessionCount');
    if (snapshot.activeSessionCount !== sessions.length) {
        fail('ClientSnapshot activeSessionCount is inconsistent');
    }
    if (typeof snapshot.isOnline !== 'boolean') {
        fail('ClientSnapshot.isOnline is invalid');
    }
    if (snapshot.isOnline !== sessions.length > 0) {
        fail('ClientSnapshot isOnline is inconsistent');
    }
    const lastSeenAtEpochMs = snapshot.lastSeenAtEpochMs;
    nullableNonNegativeInteger(lastSeenAtEpochMs, 'ClientSnapshot.lastSeenAtEpochMs');
    if (
        lastSeenAtEpochMs !==
            toClientSnapshotLastSeenAtEpochMs(principalLastSeenAtEpochMs, activeSessionHeartbeats)
    ) {
        fail('ClientSnapshot.lastSeenAtEpochMs is inconsistent');
    }
}

export function validateAuthoritativeGroupSnapshot(
    value: unknown,
    scope?: StateScope
): asserts value is GroupSnapshot {
    const snapshot = record(value, 'GroupSnapshot');
    exact(
        snapshot,
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
    const causal = causalRevision(snapshot.causalRevision, 'GroupSnapshot.causalRevision');
    positiveInteger(causal.groupRevision, 'GroupSnapshot.causalRevision.groupRevision');
    const group = record(snapshot.group, 'GroupSnapshot.group');
    exact(group, GROUP_KEYS, 'GroupSnapshot.group');
    const ref = groupRef(group, 'GroupSnapshot.group', scope);
    enumValue(group.status, ['active', 'archived', 'deleted'], 'GroupSnapshot.group.status');
    enumValue(group.kind, ['party', 'room', 'team', 'custom'], 'GroupSnapshot.group.kind');
    enumValue(group.joinMode, ['invite-only', 'code', 'open'], 'GroupSnapshot.group.joinMode');
    nullableString(group.slug, 'GroupSnapshot.group.slug');
    nonEmptyString(group.displayName, 'GroupSnapshot.group.displayName');
    nullableString(group.description, 'GroupSnapshot.group.description');
    nullablePositiveInteger(group.maxMembers, 'GroupSnapshot.group.maxMembers');
    nullablePositiveInteger(group.maxSessionsPerMember, 'GroupSnapshot.group.maxSessionsPerMember');
    nonEmptyString(group.ownerPrincipalId, 'GroupSnapshot.group.ownerPrincipalId');
    record(group.metadata, 'GroupSnapshot.group.metadata');
    nonNegativeInteger(group.activeMemberCount, 'GroupSnapshot.group.activeMemberCount');
    for (const key of ['snapshotVersion', 'metadataVersion', 'rosterVersion'] as const) {
        positiveInteger(group[key], `GroupSnapshot.group.${key}`);
    }
    if (group.snapshotVersion !== causal.groupRevision) {
        fail('GroupSnapshot group snapshotVersion differs from causalRevision');
    }
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
    for (const key of ['expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs'] as const) {
        nullablePositiveInteger(group[key], `GroupSnapshot.group.${key}`);
    }
    enumValue(
        group.lifecycleState,
        ['forming', 'connecting', 'active', 'reconfiguring'],
        'GroupSnapshot.group.lifecycleState'
    );
    nonNegativeInteger(group.formationEpoch, 'GroupSnapshot.group.formationEpoch');
    nonNegativeInteger(group.formationAttemptCount, 'GroupSnapshot.group.formationAttemptCount');
    if (group.lastFormationOutcome !== null) {
        const outcome = record(group.lastFormationOutcome, 'GroupSnapshot.group.lastFormationOutcome');
        exact(
            outcome,
            ['outcome', 'observedRate', 'atEpochMs', 'formationEpoch'],
            'GroupSnapshot.group.lastFormationOutcome'
        );
        enumValue(
            outcome.outcome,
            ['activated', 'activated-degraded', 'below-floor'],
            'GroupSnapshot.group.lastFormationOutcome.outcome'
        );
        if (
            typeof outcome.observedRate !== 'number' ||
            !Number.isFinite(outcome.observedRate) ||
            outcome.observedRate < 0 ||
            outcome.observedRate > 1
        ) {
            fail('GroupSnapshot.group.lastFormationOutcome.observedRate must be within [0, 1]');
        }
        positiveInteger(outcome.atEpochMs, 'GroupSnapshot.group.lastFormationOutcome.atEpochMs');
        nonNegativeInteger(
            outcome.formationEpoch,
            'GroupSnapshot.group.lastFormationOutcome.formationEpoch'
        );
    }
    nullablePositiveInteger(
        group.establishmentStartedAtEpochMs,
        'GroupSnapshot.group.establishmentStartedAtEpochMs'
    );
    const electorate = array(group.formationElectorate, 'GroupSnapshot.group.formationElectorate');
    if (new Set(electorate).size !== electorate.length) {
        fail('GroupSnapshot.group.formationElectorate must not repeat principal ids');
    }
    for (const principalId of electorate) {
        if (typeof principalId !== 'string' || principalId.length === 0) {
            fail('GroupSnapshot.group.formationElectorate entries must be non-empty strings');
        }
    }
    const members = array(snapshot.members, 'GroupSnapshot.members');
    const memberIds = new Set<string>();
    const activeMemberIds = new Set<string>();
    const activeOwnerIds = new Set<string>();
    for (const item of members) {
        validateGroupMember(item, ref);
        const member = record(item, 'GroupSnapshot.member');
        nonEmptyString(member.principalId, 'GroupSnapshot.member.principalId');
        if (memberIds.has(member.principalId)) {
            fail('GroupSnapshot has duplicate members');
        }
        memberIds.add(member.principalId);
        if (member.status === 'active') {
            activeMemberIds.add(member.principalId);
            if (member.role === 'owner') {
                activeOwnerIds.add(member.principalId);
            }
        }
    }
    const sessions = array(snapshot.activeSessions, 'GroupSnapshot.activeSessions');
    const sessionIds = new Set<string>();
    const onlinePrincipalIds = new Set<string>();
    for (const item of sessions) {
        const session = record(item, 'GroupSnapshot.session');
        exact(session, GROUP_SESSION_KEYS, 'GroupSnapshot.session');
        sameGroupRef(session, ref, 'GroupSnapshot.session');
        for (const key of ['sessionId', 'principalId', 'generationId'] as const) {
            nonEmptyString(session[key], `GroupSnapshot.session.${key}`);
        }
        const principalId = session.principalId;
        nonEmptyString(principalId, 'GroupSnapshot.session.principalId');
        nonEmptyString(session.sessionId, 'GroupSnapshot.session.sessionId');
        if (sessionIds.has(session.sessionId)) {
            fail('GroupSnapshot has duplicate active sessions');
        }
        if (!activeMemberIds.has(principalId)) {
            fail('GroupSnapshot active session principal is not an active member');
        }
        sessionIds.add(session.sessionId);
        positiveInteger(session.generationVersion, 'GroupSnapshot.session.generationVersion');
        const connectedAt = session.connectedAtEpochMs;
        const heartbeatAt = session.lastHeartbeatAtEpochMs;
        const expiresAt = session.expiresAtEpochMs;
        positiveInteger(connectedAt, 'GroupSnapshot.session.connectedAtEpochMs');
        positiveInteger(heartbeatAt, 'GroupSnapshot.session.lastHeartbeatAtEpochMs');
        positiveInteger(expiresAt, 'GroupSnapshot.session.expiresAtEpochMs');
        if (heartbeatAt < connectedAt || expiresAt < heartbeatAt) {
            fail('GroupSnapshot active session timestamps are causally inconsistent');
        }
        if (
            session.status !== 'active' ||
            session.disconnectedAtEpochMs !== null ||
            session.disconnectReason !== null
        ) {
            fail('GroupSnapshot active session lifecycle is invalid');
        }
        onlinePrincipalIds.add(principalId);
    }
    nonNegativeInteger(snapshot.memberCount, 'GroupSnapshot.memberCount');
    nonNegativeInteger(snapshot.onlineMemberCount, 'GroupSnapshot.onlineMemberCount');
    if (
        snapshot.memberCount !== activeMemberIds.size ||
        group.activeMemberCount !== activeMemberIds.size ||
        activeOwnerIds.size !== 1 ||
        !activeOwnerIds.has(group.ownerPrincipalId) ||
        snapshot.onlineMemberCount !== onlinePrincipalIds.size ||
        snapshot.onlineMemberCount > snapshot.memberCount
    ) {
        fail('GroupSnapshot aggregate counts are inconsistent');
    }
    if (typeof group.maxMembers === 'number' && group.activeMemberCount > group.maxMembers) {
        fail('GroupSnapshot activeMemberCount exceeds maxMembers');
    }
    if (group.status !== 'active' && sessions.length !== 0) {
        fail('GroupSnapshot inactive group has active presence');
    }
}

export function validateAuthoritativeOverlayTopologySnapshot(
    value: unknown,
    scope?: StateScope
): asserts value is RallarOverlayTopologySnapshot {
    const topology = record(value, 'RallarOverlayTopologySnapshot');
    exact(
        topology,
        [
            'sourceGroupStateCausalRevision',
            'state',
            'overlayId',
            'groupRef',
            'name',
            'topology',
            'activeSessionIds',
            'nextHopsBySessionId',
            'degreeLimit',
            'version',
            'createdByClientId',
            'createdAtEpochMs',
            'updatedAtEpochMs'
        ],
        'RallarOverlayTopologySnapshot'
    );
    causalRevision(
        topology.sourceGroupStateCausalRevision,
        'RallarOverlayTopologySnapshot.sourceGroupStateCausalRevision'
    );
    const ref = groupRef(
        record(topology.groupRef, 'RallarOverlayTopologySnapshot.groupRef'),
        'RallarOverlayTopologySnapshot.groupRef',
        scope,
        true
    );
    if (topology.state !== 'active' && topology.state !== 'removed') {
        fail('RallarOverlayTopologySnapshot.state is invalid');
    }
    nonEmptyString(topology.overlayId, 'RallarOverlayTopologySnapshot.overlayId');
    if (topology.overlayId !== toScopedOverlayId(ref)) {
        fail('RallarOverlayTopologySnapshot overlayId is not canonical');
    }
    nonEmptyString(topology.name, 'RallarOverlayTopologySnapshot.name');
    enumValue(topology.topology, ['star', 'tree', 'mesh'], 'RallarOverlayTopologySnapshot.topology');
    nonEmptyString(topology.createdByClientId, 'RallarOverlayTopologySnapshot.createdByClientId');
    const activeSessionIds = stringArray(
        topology.activeSessionIds,
        'RallarOverlayTopologySnapshot.activeSessionIds'
    );
    assertCanonicalTopologyIdentifiers(
        activeSessionIds,
        'RallarOverlayTopologySnapshot.activeSessionIds'
    );
    const activeSessionIdSet = new Set(activeSessionIds);
    const nextHops = record(
        topology.nextHopsBySessionId,
        'RallarOverlayTopologySnapshot.nextHopsBySessionId'
    );
    const routingSessionIds = Object.keys(nextHops);
    if (
        routingSessionIds.length !== activeSessionIds.length ||
        routingSessionIds.some((sessionId) => !activeSessionIdSet.has(sessionId))
    ) {
        fail('RallarOverlayTopologySnapshot routing keys differ from active sessions');
    }
    for (const [sessionId, peers] of Object.entries(nextHops)) {
        const peerIds = stringArray(
            peers,
            `RallarOverlayTopologySnapshot.nextHopsBySessionId.${sessionId}`
        );
        assertCanonicalTopologyIdentifiers(
            peerIds,
            `RallarOverlayTopologySnapshot.nextHopsBySessionId.${sessionId}`
        );
        for (const peerId of peerIds) {
            if (peerId === sessionId || !activeSessionIdSet.has(peerId)) {
                fail('RallarOverlayTopologySnapshot next hop identity is invalid');
            }
            const reverse = nextHops[peerId];
            if (!Array.isArray(reverse) || !reverse.includes(sessionId)) {
                fail('RallarOverlayTopologySnapshot next hops are not reciprocal');
            }
        }
        if (topology.state === 'removed' && peerIds.length !== 0) {
            fail('RallarOverlayTopologySnapshot removed topology has active edges');
        }
    }
    positiveInteger(topology.degreeLimit, 'RallarOverlayTopologySnapshot.degreeLimit');
    if (topology.state === 'active') {
        validateActiveTopologyGraph(nextHops, activeSessionIdSet, topology.degreeLimit);
    }
    nonNegativeInteger(topology.version, 'RallarOverlayTopologySnapshot.version');
    nonNegativeInteger(topology.createdAtEpochMs, 'RallarOverlayTopologySnapshot.createdAtEpochMs');
    nonNegativeInteger(topology.updatedAtEpochMs, 'RallarOverlayTopologySnapshot.updatedAtEpochMs');
    if (topology.createdAtEpochMs > topology.updatedAtEpochMs) {
        fail('RallarOverlayTopologySnapshot timestamps are inverted');
    }
}

function assertCanonicalTopologyIdentifiers(values: readonly string[], label: string): void {
    for (let index = 1; index < values.length; index += 1) {
        const previous = values[index - 1];
        const current = values[index];
        if (previous === undefined || current === undefined || previous >= current) {
            fail(`${label} is not canonical`);
        }
    }
}

function validateActiveTopologyGraph(
    nextHops: Readonly<Record<string, unknown>>,
    activeSessionIds: ReadonlySet<string>,
    degreeLimit: number
): void {
    for (const peers of Object.values(nextHops)) {
        if (!Array.isArray(peers) || peers.length > degreeLimit) {
            fail('RallarOverlayTopologySnapshot degree limit is exceeded');
        }
    }
    if (activeSessionIds.size <= 1) {
        return;
    }
    const first = activeSessionIds.values().next().value;
    if (typeof first !== 'string') {
        return;
    }
    const visited = new Set([first]);
    const queue = [first];
    for (let index = 0; index < queue.length; index += 1) {
        const sessionId = queue[index];
        if (sessionId === undefined) {
            continue;
        }
        const peers = nextHops[sessionId];
        if (!Array.isArray(peers)) {
            continue;
        }
        for (const peerId of peers) {
            if (typeof peerId !== 'string' || visited.has(peerId)) {
                continue;
            }
            visited.add(peerId);
            queue.push(peerId);
        }
    }
    if (visited.size !== activeSessionIds.size) {
        fail('RallarOverlayTopologySnapshot active graph is disconnected');
    }
}

export function validateAuthoritativeClientSnapshotList(
    value: unknown,
    scope: StateScope
): asserts value is ClientSnapshot[] {
    const snapshots = array(value, 'ClientSnapshot list');
    for (const snapshot of snapshots) {
        validateAuthoritativeClientSnapshot(snapshot, scope);
    }
}

export function validateAuthoritativeGroupSnapshotList(
    value: unknown,
    scope: StateScope
): asserts value is GroupSnapshot[] {
    const snapshots = array(value, 'GroupSnapshot list');
    for (const snapshot of snapshots) {
        validateAuthoritativeGroupSnapshot(snapshot, scope);
    }
}

export function validateAuthoritativeClientEvent(
    value: unknown,
    expected?: StateScope & Readonly<{ principalId?: string; }>
): asserts value is ClientEvent {
    const event = record(value, 'ClientEvent');
    exact(event, CLIENT_EVENT_KEYS, 'ClientEvent');
    const ref = clientRef(event, 'ClientEvent', expected);
    if (expected?.principalId !== undefined && ref.principalId !== expected.principalId) {
        fail('ClientEvent is outside the requested principal');
    }
    nonEmptyString(event.eventId, 'ClientEvent.eventId');
    enumValue(event.eventType, CLIENT_EVENT_TYPES, 'ClientEvent.eventType');
    positiveInteger(event.snapshotVersion, 'ClientEvent.snapshotVersion');
    nullableString(event.clientInstanceId, 'ClientEvent.clientInstanceId');
    nullableString(event.sessionId, 'ClientEvent.sessionId');
    nonNegativeInteger(event.occurredAtEpochMs, 'ClientEvent.occurredAtEpochMs');
    validateActor(event.actor, 'ClientEvent.actor');
    nullableString(event.reason, 'ClientEvent.reason');
    nullableString(event.traceId, 'ClientEvent.traceId');
    nullableString(event.requestId, 'ClientEvent.requestId');
    record(event.payload, 'ClientEvent.payload');
}

export function validateAuthoritativeGroupEvent(
    value: unknown,
    expected?: StateScope & Readonly<{ groupId?: string; }>
): asserts value is GroupEvent {
    const event = record(value, 'GroupEvent');
    exact(event, GROUP_EVENT_KEYS, 'GroupEvent');
    const ref = groupRef(event, 'GroupEvent', expected);
    if (expected?.groupId !== undefined && ref.groupId !== expected.groupId) {
        fail('GroupEvent is outside the requested group');
    }
    nonEmptyString(event.eventId, 'GroupEvent.eventId');
    enumValue(event.eventType, GROUP_EVENT_TYPES, 'GroupEvent.eventType');
    nonNegativeInteger(event.snapshotVersion, 'GroupEvent.snapshotVersion');
    causalRevision(event.causalRevision, 'GroupEvent.causalRevision');
    nonNegativeInteger(event.occurredAtEpochMs, 'GroupEvent.occurredAtEpochMs');
    validateActor(event.actor, 'GroupEvent.actor');
    nullableString(event.reason, 'GroupEvent.reason');
    nullableString(event.traceId, 'GroupEvent.traceId');
    nullableString(event.requestId, 'GroupEvent.requestId');
    record(event.payload, 'GroupEvent.payload');
}

export function validateAuthoritativeClientEventList(
    value: unknown,
    expected: StateScope & Readonly<{ principalId?: string; }>
): asserts value is ClientEvent[] {
    const events = array(value, 'ClientEvent list');
    for (const event of events) {
        validateAuthoritativeClientEvent(event, expected);
    }
}

export function validateAuthoritativeGroupEventList(
    value: unknown,
    expected: StateScope & Readonly<{ groupId?: string; }>
): asserts value is GroupEvent[] {
    const events = array(value, 'GroupEvent list');
    for (const event of events) {
        validateAuthoritativeGroupEvent(event, expected);
    }
}

export function validateAuthoritativeClientEventPage(
    value: unknown,
    expected: StateScope & Readonly<{ principalId?: string; }>
): asserts value is StateEventPage<ClientEvent> {
    validateEventPage(
        value,
        (event) => validateAuthoritativeClientEvent(event, expected),
        'ClientEventPage'
    );
}

export function validateAuthoritativeGroupEventPage(
    value: unknown,
    expected: StateScope & Readonly<{ groupId?: string; }>
): asserts value is StateEventPage<GroupEvent> {
    validateEventPage(
        value,
        (event) => validateAuthoritativeGroupEvent(event, expected),
        'GroupEventPage'
    );
}

function validateEventPage(
    value: unknown,
    validateEvent: (event: unknown) => void,
    label: string
): void {
    const page = record(value, label);
    exact(
        page,
        Object.hasOwn(page, 'nextCursor') ? ['events', 'nextCursor', 'hasMore'] : ['events', 'hasMore'],
        label
    );
    const events = array(page.events, `${label}.events`);
    for (const event of events) {
        validateEvent(event);
    }
    if (typeof page.hasMore !== 'boolean') {
        fail(`${label}.hasMore is invalid`);
    }
    if (Object.hasOwn(page, 'nextCursor')) {
        const cursor = record(page.nextCursor, `${label}.nextCursor`);
        exact(cursor, ['snapshotVersion', 'occurredAtEpochMs', 'eventId'], `${label}.nextCursor`);
        nonNegativeInteger(cursor.snapshotVersion, `${label}.nextCursor.snapshotVersion`);
        nonNegativeInteger(cursor.occurredAtEpochMs, `${label}.nextCursor.occurredAtEpochMs`);
        nonEmptyString(cursor.eventId, `${label}.nextCursor.eventId`);
    }
}

function validateGroupMember(value: unknown, ref: GroupRef): void {
    const member = record(value, 'GroupSnapshot.member');
    exact(member, GROUP_MEMBER_KEYS, 'GroupSnapshot.member');
    sameGroupRef(member, ref, 'GroupSnapshot.member');
    nonEmptyString(member.principalId, 'GroupSnapshot.member.principalId');
    enumValue(member.role, ['owner', 'admin', 'member'], 'GroupSnapshot.member.role');
    enumValue(
        member.status,
        ['invited', 'pending', 'active', 'left', 'removed', 'banned'],
        'GroupSnapshot.member.status'
    );
    nullableAudit(member.joined, 'GroupSnapshot.member.joined');
    validateAudit(member.updated, 'GroupSnapshot.member.updated');
    nullableAudit(member.left, 'GroupSnapshot.member.left');
    nullableAudit(member.removed, 'GroupSnapshot.member.removed');
    nullableAudit(member.banned, 'GroupSnapshot.member.banned');
    nullableString(member.invitedByPrincipalId, 'GroupSnapshot.member.invitedByPrincipalId');
    nullablePositiveInteger(
        member.invitationExpiresAtEpochMs,
        'GroupSnapshot.member.invitationExpiresAtEpochMs'
    );
    if ((member.status === 'invited' || member.status === 'pending') && member.joined !== null) {
        fail('GroupSnapshot invited/pending member joined must be null');
    }
    if (member.status === 'active' && member.joined === null) {
        fail('GroupSnapshot active member joined is required');
    }
    const expectedTerminal = member.status === 'left'
        ? 'left'
        : member.status === 'removed'
        ? 'removed'
        : member.status === 'banned'
        ? 'banned'
        : null;
    for (const terminal of ['left', 'removed', 'banned'] as const) {
        if ((terminal === expectedTerminal) !== (member[terminal] !== null)) {
            fail('GroupSnapshot member terminal lifecycle is invalid');
        }
    }
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

function clientRef(
    value: Record<string, unknown>,
    label: string,
    scope?: StateScope
): Readonly<{ applicationId: string; workspaceId: string; principalId: string; }> {
    nonEmptyString(value.applicationId, `${label}.applicationId`);
    nonEmptyString(value.workspaceId, `${label}.workspaceId`);
    nonEmptyString(value.principalId, `${label}.principalId`);
    requireScope(value, scope, label);
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        principalId: value.principalId
    };
}

function groupRef(
    value: Record<string, unknown>,
    label: string,
    scope?: StateScope,
    exactObject = false
): GroupRef {
    exact(value, ['applicationId', 'workspaceId', 'groupId'], label, exactObject);
    nonEmptyString(value.applicationId, `${label}.applicationId`);
    nonEmptyString(value.workspaceId, `${label}.workspaceId`);
    nonEmptyString(value.groupId, `${label}.groupId`);
    requireScope(value, scope, label);
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId
    };
}

function sameClientRef(
    value: Record<string, unknown>,
    ref: Readonly<{ applicationId: string; workspaceId: string; principalId: string; }>,
    label: string
): void {
    if (
        value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId ||
        value.principalId !== ref.principalId
    ) {
        fail(`${label} scope is inconsistent`);
    }
}

function sameGroupRef(value: Record<string, unknown>, ref: GroupRef, label: string): void {
    if (
        value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId ||
        value.groupId !== ref.groupId
    ) {
        fail(`${label} scope is inconsistent`);
    }
}

function requireScope(
    value: Record<string, unknown>,
    scope: StateScope | undefined,
    label: string
): void {
    if (
        scope &&
        (value.applicationId !== scope.applicationId || value.workspaceId !== scope.workspaceId)
    ) {
        fail(`${label} is outside the requested scope`);
    }
}

function causalRevision(
    value: unknown,
    label: string
): Readonly<{ groupRevision: number; presenceRevision: number; }> {
    const causal = record(value, label);
    exact(causal, ['groupRevision', 'presenceRevision'], label);
    nonNegativeInteger(causal.groupRevision, `${label}.groupRevision`);
    nonNegativeInteger(causal.presenceRevision, `${label}.presenceRevision`);
    return {
        groupRevision: causal.groupRevision,
        presenceRevision: causal.presenceRevision
    };
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) {
        fail(`${label} must be an object`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`);
    }
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
    if (typeof value !== 'string' || !allowed.includes(value)) {
        fail(`${label} is invalid`);
    }
}

function exact(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string,
    rejectExtras = true
): void {
    const missing = keys.find((key) => !Object.hasOwn(value, key));
    if (missing) {
        fail(`${label} is missing ${missing}`);
    }
    if (rejectExtras) {
        const allowed = new Set(keys);
        const extra = Object.keys(value).find((key) => !allowed.has(key));
        if (extra) {
            fail(`${label} has unexpected ${extra}`);
        }
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

function nullableNonNegativeInteger(value: unknown, label: string): asserts value is number | null {
    if (value !== null) {
        nonNegativeInteger(value, label);
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

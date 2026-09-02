import { toScopedOverlayId } from './api-type-utils.ts';
import {
    assertAuthoritativeGroupEvent,
    assertAuthoritativeGroupSnapshot,
    validateAuthoritativeGroupEventIssues,
    validateAuthoritativeGroupSnapshotIssues
} from './authoritative-group-state-validation.ts';
import {
    authoritativeStateAssertion
} from './authoritative-state-validation-issues.ts';
import type {
    ClientEvent,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientSession,
    ClientSnapshot
} from './client-types.ts';
import { toClientSnapshotLastSeenAtEpochMs } from './group-client-views.ts';
import type { GroupEvent, GroupRef, GroupSnapshot } from './group-types.ts';
import type { RallarOverlayTopologySnapshot } from './overlay-topology.ts';
import type { StateEventPage } from './state-event-types.ts';
import type { StateScope } from './state-types.ts';

export {
    validateAuthoritativeGroupEventIssues,
    validateAuthoritativeGroupSnapshotIssues
} from './authoritative-group-state-validation.ts';
export type { AuthoritativeStateValidationIssue } from './authoritative-state-validation-issues.ts';

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
    const principal = decodeClientSnapshotPrincipal(snapshot.principal, scope);
    const instanceIds = decodeClientSnapshotInstanceIds(snapshot.instances, principal);
    const activeSessionHeartbeats = decodeClientSnapshotSessionHeartbeats(
        snapshot.activeSessions,
        principal,
        instanceIds
    );
    assertClientSnapshotPresence(snapshot, principal.lastSeenAtEpochMs, activeSessionHeartbeats);
}

function decodeClientSnapshotPrincipal(value: unknown, scope: StateScope | undefined): ClientPrincipal {
    const principal = record(value, 'ClientSnapshot.principal');
    exact(principal, CLIENT_PRINCIPAL_KEYS, 'ClientSnapshot.principal');
    clientRef(principal, 'ClientSnapshot.principal', scope);
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
    assertAudit(principal.created, 'ClientSnapshot.principal.created');
    assertAudit(principal.updated, 'ClientSnapshot.principal.updated');
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
    return principal as ClientPrincipal;
}

function decodeClientSnapshotInstanceIds(value: unknown, ref: ClientPrincipalRef): ReadonlySet<string> {
    const instances = array(value, 'ClientSnapshot.instances');
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
        assertAudit(instance.registered, 'ClientSnapshot.instance.registered');
        assertAudit(instance.updated, 'ClientSnapshot.instance.updated');
        nullableAudit(instance.revoked, 'ClientSnapshot.instance.revoked');
        if ((instance.status === 'active') !== (instance.revoked === null)) {
            fail('ClientSnapshot instance lifecycle is invalid');
        }
    }
    return instanceIds;
}

function decodeClientSnapshotSessionHeartbeats(
    value: unknown,
    ref: ClientPrincipalRef,
    instanceIds: ReadonlySet<string>
): readonly Pick<ClientSession, 'lastHeartbeatAtEpochMs'>[] {
    const sessions = array(value, 'ClientSnapshot.activeSessions');
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
    return activeSessionHeartbeats;
}

function assertClientSnapshotPresence(
    snapshot: Record<string, unknown>,
    principalLastSeenAtEpochMs: number | null,
    activeSessionHeartbeats: readonly Pick<ClientSession, 'lastHeartbeatAtEpochMs'>[]
): void {
    nonNegativeInteger(snapshot.activeSessionCount, 'ClientSnapshot.activeSessionCount');
    if (snapshot.activeSessionCount !== activeSessionHeartbeats.length) {
        fail('ClientSnapshot activeSessionCount is inconsistent');
    }
    if (typeof snapshot.isOnline !== 'boolean') {
        fail('ClientSnapshot.isOnline is invalid');
    }
    if (snapshot.isOnline !== activeSessionHeartbeats.length > 0) {
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
    assertAuthoritativeGroupSnapshot(value, scope);
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
        scope
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
    assertOverlayTopologyRouting(topology);
    nonNegativeInteger(topology.version, 'RallarOverlayTopologySnapshot.version');
    nonNegativeInteger(topology.createdAtEpochMs, 'RallarOverlayTopologySnapshot.createdAtEpochMs');
    nonNegativeInteger(topology.updatedAtEpochMs, 'RallarOverlayTopologySnapshot.updatedAtEpochMs');
    if (topology.createdAtEpochMs > topology.updatedAtEpochMs) {
        fail('RallarOverlayTopologySnapshot timestamps are inverted');
    }
}

function assertOverlayTopologyRouting(topology: Record<string, unknown>): void {
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
        assertActiveTopologyGraph(nextHops, activeSessionIdSet, topology.degreeLimit);
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

function assertActiveTopologyGraph(
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
    assertActor(event.actor, 'ClientEvent.actor');
    nullableString(event.reason, 'ClientEvent.reason');
    nullableString(event.traceId, 'ClientEvent.traceId');
    nullableString(event.requestId, 'ClientEvent.requestId');
    record(event.payload, 'ClientEvent.payload');
}

export function validateAuthoritativeGroupEvent(
    value: unknown,
    expected?: StateScope & Readonly<{ groupId?: string; }>
): asserts value is GroupEvent {
    assertAuthoritativeGroupEvent(value, expected);
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
    assertEventPage(
        value,
        (event) => validateAuthoritativeClientEvent(event, expected),
        'ClientEventPage'
    );
}

export function validateAuthoritativeGroupEventPage(
    value: unknown,
    expected: StateScope & Readonly<{ groupId?: string; }>
): asserts value is StateEventPage<GroupEvent> {
    assertEventPage(
        value,
        (event) => validateAuthoritativeGroupEvent(event, expected),
        'GroupEventPage'
    );
}

function assertEventPage(
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

function assertAudit(value: unknown, label: string): void {
    authoritativeStateAssertion.audit(value, label);
}

function assertActor(value: unknown, label: string): void {
    authoritativeStateAssertion.actor(value, label);
}

function nullableAudit(value: unknown, label: string): void {
    if (value !== null) {
        assertAudit(value, label);
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
    scope?: StateScope
): GroupRef {
    exact(value, ['applicationId', 'workspaceId', 'groupId'], label);
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
    authoritativeStateAssertion.enum(value, allowed, label);
}

function exact(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string
): void {
    authoritativeStateAssertion.exactKeys(value, keys, label);
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
    authoritativeStateAssertion.string(value, label);
}

function nullableString(value: unknown, label: string): void {
    authoritativeStateAssertion.nullableString(value, label);
}

function nullableNonNegativeInteger(value: unknown, label: string): asserts value is number | null {
    if (value !== null) {
        nonNegativeInteger(value, label);
    }
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
    authoritativeStateAssertion.integer(value, 0, label);
}

function positiveInteger(value: unknown, label: string): asserts value is number {
    authoritativeStateAssertion.integer(value, 1, label);
}

function fail(message: string): never {
    throw new TypeError(message);
}

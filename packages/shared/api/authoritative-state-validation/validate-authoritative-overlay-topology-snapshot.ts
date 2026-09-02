import { toScopedOverlayId } from '../api-type-utils.ts';
import type { GroupRef } from '../group-types.ts';
import type { RallarOverlayTopologySnapshot } from '../overlay-topology.ts';
import type { StateScope } from '../state-types.ts';
import {
    authoritativeStateAssertion,
    type AuthoritativeStateRecord
} from './validation-issues.ts';

const SNAPSHOT_KEYS = [
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
];

export function validateAuthoritativeOverlayTopologySnapshot(
    value: unknown,
    scope?: StateScope
): asserts value is RallarOverlayTopologySnapshot {
    const path = 'RallarOverlayTopologySnapshot';
    const topology = decodeRecord(value, path);
    authoritativeStateAssertion.exactKeys(topology, SNAPSHOT_KEYS, path);
    authoritativeStateAssertion.causalRevision(
        topology.sourceGroupStateCausalRevision,
        `${path}.sourceGroupStateCausalRevision`
    );
    const ref = decodeGroupRef(topology.groupRef, `${path}.groupRef`, scope);
    authoritativeStateAssertion.enum(topology.state, ['active', 'removed'], `${path}.state`);
    authoritativeStateAssertion.string(topology.overlayId, `${path}.overlayId`);
    if (topology.overlayId !== toScopedOverlayId(ref)) {
        fail(`${path} overlayId is not canonical`);
    }
    authoritativeStateAssertion.string(topology.name, `${path}.name`);
    authoritativeStateAssertion.enum(topology.topology, ['star', 'tree', 'mesh'], `${path}.topology`);
    authoritativeStateAssertion.string(topology.createdByClientId, `${path}.createdByClientId`);
    assertOverlayTopologyRouting(topology, path);
    authoritativeStateAssertion.integer(topology.version, 0, `${path}.version`);
    authoritativeStateAssertion.integer(topology.createdAtEpochMs, 0, `${path}.createdAtEpochMs`);
    authoritativeStateAssertion.integer(topology.updatedAtEpochMs, 0, `${path}.updatedAtEpochMs`);
    if (
        typeof topology.createdAtEpochMs === 'number' &&
        typeof topology.updatedAtEpochMs === 'number' &&
        topology.createdAtEpochMs > topology.updatedAtEpochMs
    ) {
        fail(`${path} timestamps are inverted`);
    }
}

function assertOverlayTopologyRouting(topology: AuthoritativeStateRecord, path: string): void {
    const activeSessionIds = decodeStringArray(topology.activeSessionIds, `${path}.activeSessionIds`);
    assertCanonicalTopologyIdentifiers(activeSessionIds, `${path}.activeSessionIds`);
    const activeSessionIdSet = new Set(activeSessionIds);
    const nextHops = decodeRecord(topology.nextHopsBySessionId, `${path}.nextHopsBySessionId`);
    const routingSessionIds = Object.keys(nextHops);
    if (
        routingSessionIds.length !== activeSessionIds.length ||
        routingSessionIds.some((sessionId) => !activeSessionIdSet.has(sessionId))
    ) {
        fail(`${path} routing keys differ from active sessions`);
    }
    for (const [sessionId, peers] of Object.entries(nextHops)) {
        const peerPath = `${path}.nextHopsBySessionId.${sessionId}`;
        const peerIds = decodeStringArray(peers, peerPath);
        assertCanonicalTopologyIdentifiers(peerIds, peerPath);
        assertValidTopologyPeers({ activeSessionIdSet, nextHops, peerIds, sessionId, path });
        if (topology.state === 'removed' && peerIds.length !== 0) {
            fail(`${path} removed topology has active edges`);
        }
    }
    authoritativeStateAssertion.integer(topology.degreeLimit, 1, `${path}.degreeLimit`);
    if (topology.state === 'active' && typeof topology.degreeLimit === 'number') {
        assertActiveTopologyGraph(nextHops, activeSessionIdSet, topology.degreeLimit, path);
    }
}

function assertValidTopologyPeers(
    input: Readonly<{
        activeSessionIdSet: ReadonlySet<string>;
        nextHops: AuthoritativeStateRecord;
        peerIds: readonly string[];
        sessionId: string;
        path: string;
    }>
): void {
    for (const peerId of input.peerIds) {
        if (peerId === input.sessionId || !input.activeSessionIdSet.has(peerId)) {
            fail(`${input.path} next hop identity is invalid`);
        }
        const reverse = input.nextHops[peerId];
        if (!Array.isArray(reverse) || !reverse.includes(input.sessionId)) {
            fail(`${input.path} next hops are not reciprocal`);
        }
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
    nextHops: AuthoritativeStateRecord,
    activeSessionIds: ReadonlySet<string>,
    degreeLimit: number,
    path: string
): void {
    for (const peers of Object.values(nextHops)) {
        if (!Array.isArray(peers) || peers.length > degreeLimit) {
            fail(`${path} degree limit is exceeded`);
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
        fail(`${path} active graph is disconnected`);
    }
}

function decodeGroupRef<Value>(value: Value, label: string, scope?: StateScope): GroupRef {
    const ref = decodeRecord(value, label);
    authoritativeStateAssertion.exactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], label);
    const applicationId = decodeString(ref.applicationId, `${label}.applicationId`);
    const workspaceId = decodeString(ref.workspaceId, `${label}.workspaceId`);
    const groupId = decodeString(ref.groupId, `${label}.groupId`);
    if (
        scope !== undefined &&
        (applicationId !== scope.applicationId || workspaceId !== scope.workspaceId)
    ) {
        fail(`${label} is outside the requested scope`);
    }
    return { applicationId, workspaceId, groupId };
}

function decodeRecord<Value>(value: Value, label: string): AuthoritativeStateRecord {
    if (!authoritativeStateAssertion.isRecord(value)) {
        authoritativeStateAssertion.record(value, label);
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function decodeStringArray<Value>(value: Value, label: string): string[] {
    if (!Array.isArray(value)) {
        authoritativeStateAssertion.array(value, label);
        throw new TypeError(`${label} must be an array`);
    }
    const strings: string[] = [];
    for (const item of value) {
        strings.push(decodeString(item, `${label} item`));
    }
    return strings;
}

function decodeString<Value>(value: Value, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        authoritativeStateAssertion.string(value, label);
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function fail(message: string): never {
    throw new TypeError(message);
}

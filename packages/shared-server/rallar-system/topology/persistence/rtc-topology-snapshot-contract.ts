import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { compareOverlayTopologyCausalTuple, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { RtcTopologySnapshotRevisionConflictError } from './rtc-topology-errors.ts';
import { compareRtcTopologyIdentifiers } from './rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from './rtc-topology-semantic-equal.ts';

export type RtcTopologySnapshotObservation =
    | 'inserted'
    | 'advanced'
    | 'duplicate'
    | 'stale'
    | 'incomparable';

export function decideTopologySnapshot(
    current: RallarOverlayTopologySnapshot | undefined,
    incoming: RallarOverlayTopologySnapshot
): RtcTopologySnapshotObservation {
    if (!current) {
        return 'inserted';
    }
    const tupleComparison = compareTopologyTuple(incoming, current);
    if (tupleComparison === 'dominates') {
        return 'advanced';
    }
    if (tupleComparison === 'dominated') {
        return 'stale';
    }
    if (tupleComparison === 'incomparable') {
        return 'incomparable';
    }
    if (rtcTopologySemanticEqual(current, incoming)) {
        return 'duplicate';
    }
    throw new RtcTopologySnapshotRevisionConflictError(incoming.groupRef);
}

export function compareTopologyTuple(
    left: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version'>,
    right: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version'>
): 'equal' | 'dominates' | 'dominated' | 'incomparable' {
    return compareOverlayTopologyCausalTuple(left, right);
}

export function validateTopologySnapshot(
    value: unknown,
    expectedRef: GroupRef
): asserts value is RallarOverlayTopologySnapshot {
    if (!isRecord(value)) {
        throw new TypeError('RTC topology snapshot is invalid');
    }
    assertExactKeys(value, [
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
    ]);
    validateGroupRef(value.groupRef, expectedRef);
    validateGroupStateCausalRevision(value.sourceGroupStateCausalRevision);
    for (
        const field of [
            'version',
            'createdAtEpochMs',
            'updatedAtEpochMs'
        ] as const
    ) {
        if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
            throw new TypeError(`RTC topology snapshot ${field} is invalid`);
        }
    }
    if (!Number.isSafeInteger(value.degreeLimit) || (value.degreeLimit as number) < 1) {
        throw new TypeError('RTC topology snapshot degreeLimit is invalid');
    }
    if (value.state !== 'active' && value.state !== 'removed') {
        throw new TypeError('RTC topology snapshot state is invalid');
    }
    if (!['star', 'tree', 'mesh'].includes(String(value.topology))) {
        throw new TypeError('RTC topology snapshot kind is invalid');
    }
    for (const field of ['overlayId', 'name', 'createdByClientId'] as const) {
        if (typeof value[field] !== 'string' || value[field].length === 0) {
            throw new TypeError(`RTC topology snapshot ${field} is invalid`);
        }
    }
    if (!isStringArray(value.activeSessionIds) || !isRecord(value.nextHopsBySessionId)) {
        throw new TypeError('RTC topology snapshot routing is invalid');
    }
    if (value.overlayId !== toScopedOverlayId(expectedRef)) {
        throw new TypeError('RTC topology snapshot overlay identity is invalid');
    }
    if ((value.createdAtEpochMs as number) > (value.updatedAtEpochMs as number)) {
        throw new TypeError('RTC topology snapshot timestamps are inverted');
    }
    assertCanonicalIdentifiers(value.activeSessionIds, 'active sessions');
    const activeSessionIds = new Set(value.activeSessionIds);
    const routeSessionIds = Object.keys(value.nextHopsBySessionId);
    if (
        routeSessionIds.length !== activeSessionIds.size ||
        routeSessionIds.some((sessionId) => !activeSessionIds.has(sessionId))
    ) {
        throw new TypeError('RTC topology snapshot routing keys differ from active sessions');
    }
    for (const [sessionId, peers] of Object.entries(value.nextHopsBySessionId)) {
        if (!isStringArray(peers)) {
            throw new TypeError('RTC topology snapshot next hops are invalid');
        }
        assertCanonicalIdentifiers(peers, `next hops for ${sessionId}`);
        for (const peerSessionId of peers) {
            if (peerSessionId === sessionId || !activeSessionIds.has(peerSessionId)) {
                throw new TypeError('RTC topology snapshot next hop identity is invalid');
            }
            const reverse = value.nextHopsBySessionId[peerSessionId];
            if (!Array.isArray(reverse) || !reverse.includes(sessionId)) {
                throw new TypeError('RTC topology snapshot next hops are not reciprocal');
            }
        }
        if (value.state === 'removed' && peers.length > 0) {
            throw new TypeError('RTC topology removed snapshot contains active edges');
        }
    }
    if (value.state === 'active') {
        const validation = validateGroupTopologyNextHops({
            nextHopsBySessionId: value.nextHopsBySessionId as Readonly<Record<string, readonly string[]>>,
            activeSessionIds,
            maxDegree: value.degreeLimit as number,
            requireConnected: true
        });
        if (!validation.valid) {
            throw new TypeError(
                `RTC topology snapshot graph is invalid: ${
                    validation.issues
                        .map((issue) => issue.code).join(',')
                }`
            );
        }
    }
}

function validateGroupStateCausalRevision(value: unknown): void {
    if (!isRecord(value)) {
        throw new TypeError('RTC topology source causal revision is invalid');
    }
    assertExactKeys(value, ['groupRevision', 'presenceRevision']);
    for (const field of ['groupRevision', 'presenceRevision'] as const) {
        if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0) {
            throw new TypeError(`RTC topology source ${field} is invalid`);
        }
    }
}

function validateGroupRef(value: unknown, expected: GroupRef): void {
    if (!isRecord(value)) {
        throw new TypeError('RTC topology groupRef is invalid');
    }
    assertExactKeys(value, ['applicationId', 'workspaceId', 'groupId']);
    if (
        value.applicationId !== expected.applicationId ||
        value.workspaceId !== expected.workspaceId ||
        value.groupId !== expected.groupId
    ) {
        throw new TypeError('RTC topology groupRef differs from storage scope');
    }
}

function assertCanonicalIdentifiers(values: readonly string[], label: string): void {
    if (values.some((value) => value.length === 0)) {
        throw new TypeError(`RTC topology snapshot ${label} contain an empty identity`);
    }
    for (let index = 1; index < values.length; index += 1) {
        if (compareRtcTopologyIdentifiers(values[index - 1]!, values[index]!) >= 0) {
            throw new TypeError(`RTC topology snapshot ${label} are not canonical`);
        }
    }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    const actual = Object.keys(value).sort(compareRtcTopologyIdentifiers);
    const expected = [...keys].sort(compareRtcTopologyIdentifiers);
    if (!rtcTopologySemanticEqual(actual, expected)) {
        throw new TypeError('RTC topology persisted value has invalid keys');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

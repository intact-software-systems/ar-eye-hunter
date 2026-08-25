import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeRtcTopologySnapshotRouting } from './decode-rtc-topology-snapshot-routing.ts';
import { compareRtcTopologyIdentifiers } from './rtc-topology-identifiers.ts';

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
] as const;

export function decodeRtcTopologySnapshot(
    value: JsonWireValue,
    expectedRef: GroupRef
): RallarOverlayTopologySnapshot {
    const snapshot = requireJsonWireObject(value, 'RTC topology snapshot');
    requireExactKeys(snapshot, SNAPSHOT_KEYS);
    const groupRef = decodeGroupRef(snapshot.groupRef, expectedRef);
    const state = decodeSnapshotState(snapshot.state);
    const degreeLimit = requirePositiveInteger(snapshot.degreeLimit, 'degreeLimit');
    const routing = decodeRtcTopologySnapshotRouting({
        activeSessionIds: snapshot.activeSessionIds,
        nextHopsBySessionId: snapshot.nextHopsBySessionId,
        state,
        degreeLimit
    });
    const overlayId = requireNonEmptyString(snapshot.overlayId, 'overlayId');
    if (overlayId !== toScopedOverlayId(groupRef)) {
        throw new TypeError('RTC topology snapshot overlay identity is invalid');
    }
    const createdAtEpochMs = requireNonNegativeInteger(
        snapshot.createdAtEpochMs,
        'createdAtEpochMs'
    );
    const updatedAtEpochMs = requireNonNegativeInteger(
        snapshot.updatedAtEpochMs,
        'updatedAtEpochMs'
    );
    if (createdAtEpochMs > updatedAtEpochMs) {
        throw new TypeError('RTC topology snapshot timestamps are inverted');
    }
    return {
        sourceGroupStateCausalRevision: decodeCausalRevision(
            snapshot.sourceGroupStateCausalRevision
        ),
        state,
        overlayId,
        groupRef,
        name: requireNonEmptyString(snapshot.name, 'name'),
        topology: decodeTopologyKind(snapshot.topology),
        activeSessionIds: routing.activeSessionIds,
        nextHopsBySessionId: routing.nextHopsBySessionId,
        degreeLimit,
        version: requireNonNegativeInteger(snapshot.version, 'version'),
        createdByClientId: requireNonEmptyString(
            snapshot.createdByClientId,
            'createdByClientId'
        ),
        createdAtEpochMs,
        updatedAtEpochMs
    };
}

function decodeGroupRef(value: JsonWireValue, expectedRef: GroupRef): GroupRef {
    const groupRef = requireJsonWireObject(value, 'RTC topology snapshot groupRef');
    requireExactKeys(groupRef, ['applicationId', 'workspaceId', 'groupId']);
    const decoded = {
        applicationId: requireNonEmptyString(groupRef.applicationId, 'groupRef.applicationId'),
        workspaceId: requireNonEmptyString(groupRef.workspaceId, 'groupRef.workspaceId'),
        groupId: requireNonEmptyString(groupRef.groupId, 'groupRef.groupId')
    };
    if (
        decoded.applicationId !== expectedRef.applicationId ||
        decoded.workspaceId !== expectedRef.workspaceId ||
        decoded.groupId !== expectedRef.groupId
    ) {
        throw new TypeError('RTC topology snapshot groupRef differs from storage scope');
    }
    return decoded;
}

function decodeCausalRevision(value: JsonWireValue): GroupStateCausalRevision {
    const revision = requireJsonWireObject(
        value,
        'RTC topology snapshot source causal revision'
    );
    requireExactKeys(revision, ['groupRevision', 'presenceRevision']);
    return {
        groupRevision: requireNonNegativeInteger(revision.groupRevision, 'source groupRevision'),
        presenceRevision: requireNonNegativeInteger(
            revision.presenceRevision,
            'source presenceRevision'
        )
    };
}

function decodeSnapshotState(value: JsonWireValue): 'active' | 'removed' {
    if (value !== 'active' && value !== 'removed') {
        throw new TypeError('RTC topology snapshot state is invalid');
    }
    return value;
}

function decodeTopologyKind(value: JsonWireValue): RallarRtcTopologyKind {
    if (value !== 'star' && value !== 'tree' && value !== 'mesh') {
        throw new TypeError('RTC topology snapshot kind is invalid');
    }
    return value;
}

function requireNonEmptyString(
    value: JsonWireValue,
    label: string
): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC topology snapshot ${label} is invalid`);
    }
    return value;
}

function requirePositiveInteger(value: JsonWireValue, label: string): number {
    const integer = requireNonNegativeInteger(value, label);
    if (integer < 1) {
        throw new TypeError(`RTC topology snapshot ${label} is invalid`);
    }
    return integer;
}

function requireNonNegativeInteger(value: JsonWireValue, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`RTC topology snapshot ${label} is invalid`);
    }
    return value;
}

function requireExactKeys(value: JsonWireObject, keys: readonly string[]): void {
    const actual = Object.keys(value).sort(compareRtcTopologyIdentifiers);
    const expected = [...keys].sort(compareRtcTopologyIdentifiers);
    if (
        actual.length !== expected.length ||
        actual.some((key, index) => key !== expected[index])
    ) {
        throw new TypeError('RTC topology persisted value has invalid keys');
    }
}

function requireJsonWireObject(
    value: JsonWireValue,
    label: string
): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

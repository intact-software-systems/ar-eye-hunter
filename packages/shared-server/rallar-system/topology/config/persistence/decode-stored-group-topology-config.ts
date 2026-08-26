import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    readStoredTopologyConfigBoundary,
    readStoredTopologyOverrideBoundary
} from '../mutation/topology-config-mutation-boundary.ts';

export function decodeStoredGroupTopologyConfig(
    value: JsonWireValue,
    expectedRef?: GroupRef
): StoredGroupTopologyConfig {
    const validationRef = expectedRef ?? storedTopologyGroupRef(value);
    return readStoredTopologyConfigBoundary(value, validationRef);
}

export function decodeStoredGroupTopologyOverride(
    value: JsonWireValue,
    expectedRef?: GroupRef
): StoredGroupTopologyOverride {
    const validationRef = expectedRef ?? storedTopologyGroupRef(value);
    return readStoredTopologyOverrideBoundary(value, validationRef);
}

export function storedTopologyGroupRef(value: JsonWireValue): GroupRef {
    if (!isJsonWireObject(value)) {
        throw new TypeError('Stored topology config generation source is invalid');
    }
    const groupRef = value.groupRef;
    if (!isJsonWireObject(groupRef)) {
        throw new TypeError('Stored topology config generation source groupRef is invalid');
    }
    if (
        typeof groupRef.applicationId !== 'string' ||
        groupRef.applicationId.trim().length === 0 ||
        typeof groupRef.workspaceId !== 'string' ||
        groupRef.workspaceId.trim().length === 0 ||
        typeof groupRef.groupId !== 'string' ||
        groupRef.groupId.trim().length === 0
    ) {
        throw new TypeError('Stored topology config generation source groupRef is invalid');
    }
    return {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
}

function isJsonWireObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

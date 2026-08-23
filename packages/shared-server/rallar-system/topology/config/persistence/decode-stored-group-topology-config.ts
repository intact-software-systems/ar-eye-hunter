import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    readStoredTopologyConfigBoundary,
    readStoredTopologyOverrideBoundary
} from '../mutation/topology-config-mutation-boundary.ts';

export function decodeStoredGroupTopologyConfig(
    value: unknown,
    expectedRef?: GroupRef
): StoredGroupTopologyConfig {
    const validationRef = expectedRef ?? storedTopologyGroupRef(value);
    return readStoredTopologyConfigBoundary(value, validationRef);
}

export function decodeStoredGroupTopologyOverride(
    value: unknown,
    expectedRef?: GroupRef
): StoredGroupTopologyOverride {
    const validationRef = expectedRef ?? storedTopologyGroupRef(value);
    return readStoredTopologyOverrideBoundary(value, validationRef);
}

export function storedTopologyGroupRef(value: unknown): GroupRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Stored topology config generation source is invalid');
    }
    const groupRef = (value as Readonly<{ groupRef?: unknown; }>).groupRef;
    if (!groupRef || typeof groupRef !== 'object' || Array.isArray(groupRef)) {
        throw new TypeError('Stored topology config generation source groupRef is invalid');
    }
    const candidate = groupRef as Readonly<Record<string, unknown>>;
    if (
        typeof candidate.applicationId !== 'string' ||
        candidate.applicationId.trim().length === 0 ||
        typeof candidate.workspaceId !== 'string' ||
        candidate.workspaceId.trim().length === 0 ||
        typeof candidate.groupId !== 'string' ||
        candidate.groupId.trim().length === 0
    ) {
        throw new TypeError('Stored topology config generation source groupRef is invalid');
    }
    return {
        applicationId: candidate.applicationId,
        workspaceId: candidate.workspaceId,
        groupId: candidate.groupId
    };
}

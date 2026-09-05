import type {
    EffectiveGroupTopologyConfig,
    GroupTopologyConfigAcceptedCausalRevision
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import {
    GroupTopologyConfigValidationError,
    validateEffectiveGroupTopologyConfig
} from '../group-topology-config.ts';

export function assertTopologyConfigObject(value: object, label: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function assertTopologyConfigExactKeys(
    value: object,
    keys: readonly string[],
    label: string
): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

export function assertTopologyStorageRevision(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function assertTopologyPositiveInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function requireTopologyString(value: string, label: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function assertTopologyGroupRef(value: GroupRef, label: string): void {
    assertTopologyConfigObject(value, label);
    requireTopologyString(value.applicationId, `${label} applicationId`);
    requireTopologyString(value.workspaceId, `${label} workspaceId`);
    requireTopologyString(value.groupId, `${label} groupId`);
}

export function sameTopologyGroupRef(left: GroupRef, right: GroupRef): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId
    );
}

export function assertAcceptedTopologyConfig(
    value: EffectiveGroupTopologyConfig,
    label: string
): void {
    assertTopologyConfigObject(value, label);
    assertTopologyConfigExactKeys(
        value,
        ['topologyKind', 'degreeLimit', 'treeMinSize', 'meshMinSize', 'meshParamK'],
        label
    );
    const { topologyKind, degreeLimit, treeMinSize, meshMinSize, meshParamK } = value;
    if (
        topologyKind !== 'auto' &&
        topologyKind !== 'star' &&
        topologyKind !== 'tree' &&
        topologyKind !== 'mesh'
    ) {
        throw new TypeError(`${label} topologyKind is invalid`);
    }
    assertTopologyPositiveInteger(degreeLimit, `${label} degreeLimit`);
    assertTopologyPositiveInteger(treeMinSize, `${label} treeMinSize`);
    assertTopologyPositiveInteger(meshMinSize, `${label} meshMinSize`);
    assertTopologyPositiveInteger(meshParamK, `${label} meshParamK`);
    const issues = validateEffectiveGroupTopologyConfig({
        topologyKind,
        degreeLimit,
        treeMinSize,
        meshMinSize,
        meshParamK
    });
    if (issues.length > 0) {
        throw new GroupTopologyConfigValidationError(issues);
    }
}

export function assertTopologyAcceptedCausalRevision(
    value: GroupTopologyConfigAcceptedCausalRevision,
    label: string
): void {
    assertTopologyConfigObject(value, label);
}

export function assertTopologyCausalRevision(
    value: GroupStateCausalRevision,
    label: string
): void {
    assertTopologyConfigObject(value, label);
    assertTopologyConfigExactKeys(value, ['groupRevision', 'presenceRevision'], label);
    assertTopologyStorageRevision(value.groupRevision, `${label} groupRevision`);
    assertTopologyStorageRevision(value.presenceRevision, `${label} presenceRevision`);
}

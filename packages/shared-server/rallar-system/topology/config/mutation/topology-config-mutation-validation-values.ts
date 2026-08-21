import type {
    EffectiveGroupTopologyConfig,
    GroupTopologyConfigAcceptedCausalRevision
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { validateEffectiveGroupTopologyConfig } from '../group-topology-config.ts';

export function validateTopologyConfigObject(value: object, label: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function validateTopologyConfigExactKeys(
    value: object,
    keys: readonly string[],
    label: string
): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

export function validateTopologyStorageRevision(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function validateTopologyPositiveInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function requireTopologyString(value: string, label: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function validateTopologyGroupRef(value: GroupRef, label: string): void {
    validateTopologyConfigObject(value, label);
    requireTopologyString(value.applicationId, `${label} applicationId`);
    if (value.workspaceId !== undefined) {
        requireTopologyString(value.workspaceId, `${label} workspaceId`);
    }
    requireTopologyString(value.groupId, `${label} groupId`);
}

export function sameTopologyGroupRef(left: GroupRef, right: GroupRef): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId
    );
}

export function validateAcceptedTopologyConfig(
    value: EffectiveGroupTopologyConfig,
    label: string
): void {
    validateTopologyConfigObject(value, label);
    validateTopologyConfigExactKeys(
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
    validateTopologyPositiveInteger(degreeLimit, `${label} degreeLimit`);
    validateTopologyPositiveInteger(treeMinSize, `${label} treeMinSize`);
    validateTopologyPositiveInteger(meshMinSize, `${label} meshMinSize`);
    validateTopologyPositiveInteger(meshParamK, `${label} meshParamK`);
    validateEffectiveGroupTopologyConfig({
        topologyKind,
        degreeLimit,
        treeMinSize,
        meshMinSize,
        meshParamK
    });
}

export function validateTopologyAcceptedCausalRevision(
    value: GroupTopologyConfigAcceptedCausalRevision,
    label: string
): void {
    validateTopologyConfigObject(value, label);
}

export function validateTopologyCausalRevision(
    value: GroupStateCausalRevision,
    label: string
): void {
    validateTopologyConfigObject(value, label);
    validateTopologyConfigExactKeys(value, ['groupRevision', 'presenceRevision'], label);
    validateTopologyStorageRevision(value.groupRevision, `${label} groupRevision`);
    validateTopologyStorageRevision(value.presenceRevision, `${label} presenceRevision`);
}

import type {
    EffectiveGroupTopologyConfig,
    GroupTopologyConfigPatch,
    GroupTopologyConfigView,
    GroupTopologyKindSetting,
    GroupTopologyValidationIssue,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { RallarRtcTopologyServiceOptions } from './rallar-rtc-topology-service.ts';

export const DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 15 * 60 * 1000;
export const MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DEGREE_LIMIT = 5;
const DEFAULT_TREE_MIN_SIZE = 5;
const DEFAULT_MESH_MIN_SIZE = 16;
const DEFAULT_MESH_PARAM_K = 2;

export class GroupTopologyConfigValidationError extends Error {
    readonly status = 422;
    readonly code = 'group-topology-config-validation-failed';

    constructor(readonly issues: readonly GroupTopologyValidationIssue[]) {
        super('Group topology config validation failed');
        this.name = 'GroupTopologyConfigValidationError';
    }
}

export type ResolveGroupTopologyConfigInput = Readonly<{
    serverOptions?: GroupTopologyServerOptions;
    durable?: StoredGroupTopologyConfig;
    temporary?: StoredGroupTopologyOverride;
    requestOptions?: GroupTopologyConfigPatch;
}>;

export type GroupTopologyServerOptions =
    & RallarRtcTopologyServiceOptions
    & Readonly<{ topologyKind?: GroupTopologyKindSetting }>;

export type ResolveOverrideExpiresAtEpochMsInput = Readonly<{
    nowEpochMs: number;
    ttlMs?: number;
    expiresAtEpochMs?: number;
}>;

export function readDefaultGroupTopologyConfig(
    serverOptions: GroupTopologyServerOptions = {},
): EffectiveGroupTopologyConfig {
    return {
        topologyKind: serverOptions.topologyKind ?? 'auto',
        degreeLimit: serverOptions.degreeLimit ?? DEFAULT_DEGREE_LIMIT,
        treeMinSize: serverOptions.treeMinSize ?? DEFAULT_TREE_MIN_SIZE,
        meshMinSize: serverOptions.meshMinSize ?? DEFAULT_MESH_MIN_SIZE,
        meshParamK: serverOptions.meshParamK ?? DEFAULT_MESH_PARAM_K,
    };
}

export function validateGroupTopologyConfigPatch(
    patch: GroupTopologyConfigPatch,
): void {
    const issues: GroupTopologyValidationIssue[] = [];

    for (
        const key of [
            'degreeLimit',
            'treeMinSize',
            'meshMinSize',
            'meshParamK',
        ] as const
    ) {
        const value = patch[key];
        if (value === undefined || value === null) {
            continue;
        }

        if (!Number.isInteger(value) || value <= 0) {
            issues.push({
                code: 'invalid-positive-integer',
                path: [key],
                message: `${key} must be a positive integer`,
                details: { value },
            });
        }
    }

    if (
        patch.topologyKind !== undefined &&
        patch.topologyKind !== null &&
        !['auto', 'star', 'tree', 'mesh'].includes(patch.topologyKind)
    ) {
        issues.push({
            code: 'invalid-topology-kind',
            path: ['topologyKind'],
            message: 'topologyKind must be auto, star, tree, or mesh',
            details: { value: patch.topologyKind },
        });
    }

    throwIfIssues(issues);
}

export function validateEffectiveGroupTopologyConfig(
    config: EffectiveGroupTopologyConfig,
): void {
    validateGroupTopologyConfigPatch(config);

    const issues: GroupTopologyValidationIssue[] = [];
    if (config.meshMinSize < config.treeMinSize) {
        issues.push({
            code: 'mesh-min-size-before-tree-min-size',
            path: ['meshMinSize'],
            message: 'meshMinSize must be greater than or equal to treeMinSize',
            details: {
                meshMinSize: config.meshMinSize,
                treeMinSize: config.treeMinSize,
            },
        });
    }

    if (config.meshParamK > config.degreeLimit) {
        issues.push({
            code: 'mesh-param-k-exceeds-degree-limit',
            path: ['meshParamK'],
            message: 'meshParamK must be less than or equal to degreeLimit',
            details: {
                meshParamK: config.meshParamK,
                degreeLimit: config.degreeLimit,
            },
        });
    }

    throwIfIssues(issues);
}

export function resolveGroupTopologyConfig(
    input: ResolveGroupTopologyConfigInput,
): GroupTopologyConfigView {
    if (input.durable) {
        validateGroupTopologyConfigPatch(input.durable.config);
    }
    if (input.temporary) {
        validateGroupTopologyConfigPatch(input.temporary.config);
    }
    if (input.requestOptions) {
        validateGroupTopologyConfigPatch(input.requestOptions);
    }

    const serverDefaults = readDefaultGroupTopologyConfig(input.serverOptions);
    const effective = {
        ...serverDefaults,
        ...(input.durable?.config ?? {}),
        ...(input.temporary?.config ?? {}),
        ...toSetTopologyConfigPatch(input.requestOptions ?? {}),
    };
    validateEffectiveGroupTopologyConfig(effective);

    return {
        serverDefaults,
        durable: input.durable ?? null,
        temporary: input.temporary ?? null,
        requestOptions: input.requestOptions ?? null,
        effective,
    };
}

function toSetTopologyConfigPatch(
    patch: GroupTopologyConfigPatch,
): Partial<EffectiveGroupTopologyConfig> {
    return {
        ...(patch.topologyKind === undefined || patch.topologyKind === null
            ? {}
            : { topologyKind: patch.topologyKind }),
        ...(patch.degreeLimit === undefined || patch.degreeLimit === null
            ? {}
            : { degreeLimit: patch.degreeLimit }),
        ...(patch.treeMinSize === undefined || patch.treeMinSize === null
            ? {}
            : { treeMinSize: patch.treeMinSize }),
        ...(patch.meshMinSize === undefined || patch.meshMinSize === null
            ? {}
            : { meshMinSize: patch.meshMinSize }),
        ...(patch.meshParamK === undefined || patch.meshParamK === null
            ? {}
            : { meshParamK: patch.meshParamK }),
    };
}

export function resolveOverrideExpiresAtEpochMs(
    input: ResolveOverrideExpiresAtEpochMsInput,
): number {
    const maxExpiresAtEpochMs = input.nowEpochMs + MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS;
    const requestedExpiresAtEpochMs = input.expiresAtEpochMs ??
        input.nowEpochMs + (input.ttlMs ?? DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS);
    if (
        !Number.isFinite(requestedExpiresAtEpochMs) ||
        requestedExpiresAtEpochMs <= input.nowEpochMs
    ) {
        throwIfIssues([{
            code: 'override-expiry-not-in-future',
            path: [input.expiresAtEpochMs === undefined ? 'ttlMs' : 'expiresAtEpochMs'],
            message: 'Temporary topology override expiry must be in the future',
            details: {
                nowEpochMs: input.nowEpochMs,
                requestedExpiresAtEpochMs,
            },
        }]);
    }
    return Math.min(requestedExpiresAtEpochMs, maxExpiresAtEpochMs);
}

function throwIfIssues(issues: readonly GroupTopologyValidationIssue[]): void {
    if (issues.length > 0) {
        throw new GroupTopologyConfigValidationError(issues);
    }
}

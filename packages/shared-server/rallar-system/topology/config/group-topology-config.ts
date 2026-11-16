import type {
    EffectiveGroupTopologyConfig,
    GroupTopologyConfigPatch,
    GroupTopologyConfigView,
    GroupTopologyKindSetting,
    GroupTopologyValidationIssue,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { RallarRtcTopologyServiceOptions } from '../runtime/rallar-rtc-topology-service.ts';

export const DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 15 * 60 * 1000;
export const MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DEGREE_LIMIT = 5;
const DEFAULT_TREE_MIN_SIZE = 5;
const DEFAULT_MESH_MIN_SIZE = 16;
const DEFAULT_MESH_PARAM_K = 2;
const MIN_DEGREE_LIMIT = 2;
const INTEGER_FIELDS = ['degreeLimit', 'treeMinSize', 'meshMinSize', 'meshParamK'] as const;

type GroupTopologyConfigIntegerField = (typeof INTEGER_FIELDS)[number];

export class GroupTopologyConfigValidationError extends Error {
    readonly status = 422;
    readonly code = 'group-topology-config-validation-failed';

    readonly issues: readonly GroupTopologyValidationIssue[];

    constructor(issues: readonly GroupTopologyValidationIssue[]) {
        super('Group topology config validation failed');
        this.issues = issues;
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
    & Readonly<{ topologyKind?: GroupTopologyKindSetting; }>;

export type ResolveOverrideExpiresAtEpochMsInput = Readonly<{
    nowEpochMs: number;
    ttlMs?: number;
    expiresAtEpochMs?: number;
}>;

export function resolveDefaultGroupTopologyConfig(
    serverOptions: GroupTopologyServerOptions = {}
): EffectiveGroupTopologyConfig {
    return {
        topologyKind: serverOptions.topologyKind ?? 'auto',
        degreeLimit: serverOptions.degreeLimit ?? DEFAULT_DEGREE_LIMIT,
        treeMinSize: serverOptions.treeMinSize ?? DEFAULT_TREE_MIN_SIZE,
        meshMinSize: serverOptions.meshMinSize ?? DEFAULT_MESH_MIN_SIZE,
        meshParamK: serverOptions.meshParamK ?? DEFAULT_MESH_PARAM_K
    };
}

/** A room topology configuration issue with the fields the rule that raised it reads. */
export interface GroupTopologyConfigRuleIssue {
    readonly fields: readonly (keyof EffectiveGroupTopologyConfig)[];
    readonly issue: GroupTopologyValidationIssue;
}

export function validateGroupTopologyConfigPatch(
    patch: GroupTopologyConfigPatch
): readonly GroupTopologyValidationIssue[] {
    return validateGroupTopologyConfigPatchRules(patch).map((ruleIssue) => ruleIssue.issue);
}

export function validateEffectiveGroupTopologyConfig(
    config: EffectiveGroupTopologyConfig
): readonly GroupTopologyValidationIssue[] {
    return validateEffectiveGroupTopologyConfigRules(config).map((ruleIssue) => ruleIssue.issue);
}

/**
 * Every issue of the room rule with the fields its rule reads, so a caller that refused a field on its own can drop
 * the issues that read it.
 */
export function validateEffectiveGroupTopologyConfigRules(
    config: EffectiveGroupTopologyConfig
): readonly GroupTopologyConfigRuleIssue[] {
    return [
        ...validateGroupTopologyConfigPatchRules(config),
        ...validateMeshMinSizeRule(config),
        ...validateMeshParamKRule(config)
    ];
}

function validateMeshMinSizeRule(config: EffectiveGroupTopologyConfig): readonly GroupTopologyConfigRuleIssue[] {
    if (config.meshMinSize >= config.treeMinSize) {
        return [];
    }
    return [{
        fields: ['meshMinSize', 'treeMinSize'],
        issue: {
            code: 'mesh-min-size-before-tree-min-size',
            path: ['meshMinSize'],
            message: 'meshMinSize must be greater than or equal to treeMinSize',
            details: { meshMinSize: config.meshMinSize, treeMinSize: config.treeMinSize }
        }
    }];
}

function validateMeshParamKRule(config: EffectiveGroupTopologyConfig): readonly GroupTopologyConfigRuleIssue[] {
    if (config.meshParamK < config.degreeLimit) {
        return [];
    }
    return [{
        fields: ['meshParamK', 'degreeLimit'],
        issue: {
            code: 'mesh-param-k-not-below-degree-limit',
            path: ['meshParamK'],
            message: 'meshParamK must be less than degreeLimit',
            details: { meshParamK: config.meshParamK, degreeLimit: config.degreeLimit }
        }
    }];
}

function validateGroupTopologyConfigPatchRules(
    patch: GroupTopologyConfigPatch
): readonly GroupTopologyConfigRuleIssue[] {
    const issues = INTEGER_FIELDS.flatMap((field) => validateIntegerFieldRule(field, patch[field]));
    if (
        patch.topologyKind !== undefined &&
        patch.topologyKind !== null &&
        !['auto', 'star', 'tree', 'mesh'].includes(patch.topologyKind)
    ) {
        issues.push({
            fields: ['topologyKind'],
            issue: {
                code: 'invalid-topology-kind',
                path: ['topologyKind'],
                message: 'topologyKind must be auto, star, tree, or mesh',
                details: { value: patch.topologyKind }
            }
        });
    }
    return issues;
}

function validateIntegerFieldRule(
    field: GroupTopologyConfigIntegerField,
    value: number | null | undefined
): readonly GroupTopologyConfigRuleIssue[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Number.isInteger(value) || value <= 0) {
        return [toFieldRuleIssue(field, {
            code: 'invalid-positive-integer',
            path: [field],
            message: `${field} must be a positive integer`,
            details: { value }
        })];
    }
    if (field === 'degreeLimit' && value < MIN_DEGREE_LIMIT) {
        return [toFieldRuleIssue(field, {
            code: 'degree-limit-below-two',
            path: [field],
            message: `${field} must be at least ${MIN_DEGREE_LIMIT}`,
            details: { value }
        })];
    }
    return [];
}

function toFieldRuleIssue(
    field: GroupTopologyConfigIntegerField,
    issue: GroupTopologyValidationIssue
): GroupTopologyConfigRuleIssue {
    return { fields: [field], issue };
}

export function resolveGroupTopologyConfig(
    input: ResolveGroupTopologyConfigInput
): GroupTopologyConfigView {
    if (input.durable) {
        throwGroupTopologyConfigValidationError(
            validateGroupTopologyConfigPatch(input.durable.config)
        );
    }
    if (input.temporary) {
        throwGroupTopologyConfigValidationError(
            validateGroupTopologyConfigPatch(input.temporary.config)
        );
    }
    if (input.requestOptions) {
        throwGroupTopologyConfigValidationError(
            validateGroupTopologyConfigPatch(input.requestOptions)
        );
    }

    const serverDefaults = resolveDefaultGroupTopologyConfig(input.serverOptions);
    const effective = {
        ...serverDefaults,
        ...(input.durable?.config ?? {}),
        ...(input.temporary?.config ?? {}),
        ...toSetTopologyConfigPatch(input.requestOptions ?? {})
    };
    throwGroupTopologyConfigValidationError(validateEffectiveGroupTopologyConfig(effective));

    return {
        serverDefaults,
        durable: input.durable ?? null,
        temporary: input.temporary ?? null,
        requestOptions: input.requestOptions ?? null,
        effective
    };
}

function toSetTopologyConfigPatch(
    patch: GroupTopologyConfigPatch
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
            : { meshParamK: patch.meshParamK })
    };
}

export function resolveOverrideExpiresAtEpochMs(
    input: ResolveOverrideExpiresAtEpochMsInput
): number {
    const requestedExpiresAtEpochMs = computeOverrideExpiresAtEpochMs(input);
    if (
        !Number.isFinite(requestedExpiresAtEpochMs) ||
        requestedExpiresAtEpochMs <= input.nowEpochMs
    ) {
        throwGroupTopologyConfigValidationError([
            {
                code: 'override-expiry-not-in-future',
                path: [input.expiresAtEpochMs === undefined ? 'ttlMs' : 'expiresAtEpochMs'],
                message: 'Temporary topology override expiry must be in the future',
                details: {
                    nowEpochMs: input.nowEpochMs,
                    requestedExpiresAtEpochMs
                }
            }
        ]);
    }
    return requestedExpiresAtEpochMs;
}

export function computeOverrideExpiresAtEpochMs(
    input: ResolveOverrideExpiresAtEpochMsInput
): number {
    const requestedExpiresAtEpochMs = input.expiresAtEpochMs ??
        input.nowEpochMs + (input.ttlMs ?? DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS);
    return Math.min(
        requestedExpiresAtEpochMs,
        input.nowEpochMs + MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS
    );
}

function throwGroupTopologyConfigValidationError(
    issues: readonly GroupTopologyValidationIssue[]
): void {
    if (issues.length > 0) {
        throw new GroupTopologyConfigValidationError(issues);
    }
}

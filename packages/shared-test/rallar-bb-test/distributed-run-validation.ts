import { Either } from '@shared/resilience/Either.ts';

import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRoleAssignmentPolicy,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedStartMode,
    RallarBlackBoxDistributedTargetPolicyMode
} from './distributed-run.ts';
import {
    validateDistributedGroupAssertions,
    type RallarBlackBoxDistributedGroupAssertion
} from './distributed/group-assertions.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA } from './schema.ts';
import { validateJsonSchema } from './schema/json-schema-validation.ts';

export interface DistributedRunManifestValidationIssue {
    readonly source: 'schema' | 'contract';
    readonly path: string;
    readonly message: string;
}

export interface RallarBlackBoxDistributedRunValidationIssue {
    readonly path: string;
    readonly message: string;
}

/**
 * A manifest the schema accepted before its variant rules ran: the schema admits a variant-only field on any
 * variant, so the contract rules read those fields as optional here and the domain manifest type applies only
 * once they pass.
 */
export interface DistributedRunManifestSchemaValue {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly recipes: readonly RallarBlackBoxDistributedRunRecipeSelection[];
    readonly targetPolicy: DistributedRunTargetPolicySchemaValue;
    readonly roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
    /** Absent when roles come from targetPolicy.roles or roleAssignments instead of a pattern. */
    readonly roleAssignmentPolicy?: RallarBlackBoxDistributedRoleAssignmentPolicy;
    readonly ackTimeoutMs: number;
    readonly barrier: DistributedRunBarrierSchemaValue;
    readonly startMode: RallarBlackBoxDistributedStartMode;
    /** Absent unless the author set a start deadline; the contract accepts one only on a scheduled start. */
    readonly startDeadlineEpochMs?: number;
    readonly groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[];
}

export interface DistributedRunTargetPolicySchemaValue {
    readonly mode: RallarBlackBoxDistributedTargetPolicyMode;
    /** Absent when staging accepts however many agents the policy resolves. */
    readonly expectedParticipantCount?: number;
    /** Absent unless the author listed agents; the contract accepts them only on a selected-agents policy. */
    readonly agentIds?: readonly string[];
    /** Absent unless the author mapped roles; the contract accepts them only on a role-map policy. */
    readonly roles?: Readonly<Record<string, readonly string[]>>;
}

export interface DistributedRunBarrierSchemaValue {
    readonly enabled: boolean;
    /** Absent unless the author set a barrier timeout; the contract requires one exactly when enabled. */
    readonly timeoutMs?: number;
}

/**
 * A manifest from JSON: the schema checks its shape and every author setting, and the contract checks
 * the cross-field and variant rules only once that shape holds.
 */
export function decodeDistributedRunManifest(
    value: unknown
): Either<readonly DistributedRunManifestValidationIssue[], RallarBlackBoxDistributedRunManifest> {
    const schemaValidation = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, value);
    if (!schemaValidation.ok) {
        return Either.ofLeft(schemaValidation.errors.map((error) => ({
            source: 'schema' as const,
            path: error.path,
            message: error.message
        })));
    }

    const contractIssues = validateDistributedRunManifestContract(value as DistributedRunManifestSchemaValue);
    return contractIssues.length === 0
        ? Either.ofRight(value as RallarBlackBoxDistributedRunManifest)
        : Either.ofLeft(contractIssues.map((issue) => ({
            source: 'contract' as const,
            path: issue.path,
            message: issue.message
        })));
}

/** The schema issues a typed manifest has, or its contract issues once the schema holds; empty when it is valid. */
export function validateDistributedRunManifest(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly DistributedRunManifestValidationIssue[] {
    return decodeDistributedRunManifest(manifest).left ?? [];
}

export function toDistributedRunManifestValidationText(
    issues: readonly DistributedRunManifestValidationIssue[]
): string {
    return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

/** Cross-field and variant rules a schema-valid manifest must also satisfy; empty when it does. */
export function validateDistributedRunManifestContract(
    manifest: DistributedRunManifestSchemaValue
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return [
        ...validateManifestIdentity(manifest),
        ...validateTargetPolicy(manifest),
        ...validateStart(manifest),
        ...validateTimeouts(manifest),
        ...validateDistributedGroupAssertions(manifest)
    ];
}

function validateManifestIdentity(
    manifest: DistributedRunManifestSchemaValue
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return [
        ...validateNonEmptyText(manifest.distributedRunId, '$.distributedRunId'),
        ...validateNonEmptyText(manifest.controlRunId, '$.controlRunId'),
        ...validateNonEmptyText(manifest.group.applicationId, '$.group.applicationId'),
        ...validateNonEmptyText(manifest.group.workspaceId, '$.group.workspaceId'),
        ...validateNonEmptyText(manifest.group.groupId, '$.group.groupId'),
        ...(manifest.recipes.length === 0
            ? [{ path: '$.recipes', message: 'At least one recipe selection is required.' }]
            : []),
        ...manifest.recipes.flatMap((recipe, index) =>
            validateNonEmptyText(recipe.recipeId, `$.recipes[${index}].recipeId`)
        )
    ];
}

function validateTargetPolicy(
    manifest: DistributedRunManifestSchemaValue
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const policy = manifest.targetPolicy;
    const errors: RallarBlackBoxDistributedRunValidationIssue[] = [];
    const expectedParticipantCount = policy.expectedParticipantCount;
    if (
        expectedParticipantCount !== undefined &&
        (!Number.isInteger(expectedParticipantCount) || expectedParticipantCount < 1)
    ) {
        errors.push({
            path: '$.targetPolicy.expectedParticipantCount',
            message: 'Expected participant count must be an integer >= 1.'
        });
    }
    if (policy.mode !== 'selected-agents' && policy.agentIds !== undefined) {
        errors.push({
            path: '$.targetPolicy.agentIds',
            message: 'Only selected-agents target policies accept agentIds.'
        });
    }
    if (policy.mode !== 'role-map' && policy.roles !== undefined) {
        errors.push({ path: '$.targetPolicy.roles', message: 'Only role-map target policies accept roles.' });
    }
    if (policy.mode === 'selected-agents' && (policy.agentIds === undefined || policy.agentIds.length === 0)) {
        errors.push({
            path: '$.targetPolicy.agentIds',
            message: 'selected-agents target policy requires at least one agent ID.'
        });
    }
    if (policy.mode === 'role-map') {
        errors.push(...validateRoleMap(policy.roles, manifest.roleAssignments));
    }
    return errors;
}

function validateRoleMap(
    roles: DistributedRunTargetPolicySchemaValue['roles'],
    roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[]
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    if (roles === undefined) {
        return [{ path: '$.targetPolicy.roles', message: 'A role-map target policy requires roles.' }];
    }
    const roleMapCount = Object.values(roles).reduce((count, agentIds) => count + agentIds.length, 0);
    return roleMapCount === 0 && roleAssignments.length === 0
        ? [{ path: '$.targetPolicy.roles', message: 'role-map target policy requires roles or roleAssignments.' }]
        : [];
}

function validateStart(
    manifest: DistributedRunManifestSchemaValue
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const scheduled = manifest.startMode === 'scheduled';
    if (scheduled && manifest.startDeadlineEpochMs === undefined) {
        return [{
            path: '$.startDeadlineEpochMs',
            message: 'Scheduled distributed runs require startDeadlineEpochMs.'
        }];
    }
    return !scheduled && manifest.startDeadlineEpochMs !== undefined
        ? [{ path: '$.startDeadlineEpochMs', message: 'Only scheduled distributed runs accept startDeadlineEpochMs.' }]
        : [];
}

function validateTimeouts(
    manifest: DistributedRunManifestSchemaValue
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return [
        ...(Number.isInteger(manifest.ackTimeoutMs) && manifest.ackTimeoutMs >= 1
            ? []
            : [{ path: '$.ackTimeoutMs', message: 'ACK timeout must be an integer >= 1.' }]),
        ...validateBarrier(manifest.barrier)
    ];
}

function validateBarrier(
    barrier: DistributedRunBarrierSchemaValue
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const path = '$.barrier.timeoutMs';
    if (!barrier.enabled) {
        return barrier.timeoutMs === undefined ? [] : [{ path, message: 'A disabled barrier accepts no timeoutMs.' }];
    }
    if (barrier.timeoutMs === undefined) {
        return [{ path, message: 'An enabled barrier requires timeoutMs.' }];
    }
    return Number.isInteger(barrier.timeoutMs) && barrier.timeoutMs >= 1
        ? []
        : [{ path, message: 'Barrier timeout must be an integer >= 1.' }];
}

function validateNonEmptyText(value: string, path: string): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return value.trim().length > 0 ? [] : [{ path, message: 'A non-empty string is required.' }];
}

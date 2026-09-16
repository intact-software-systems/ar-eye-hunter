import { Either } from '@shared/resilience/Either.ts';

import {
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS,
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS,
    type RallarBlackBoxDistributedRoleAssignment,
    type RallarBlackBoxDistributedRoleMapTargetPolicy,
    type RallarBlackBoxDistributedRunManifest
} from './distributed-run.ts';
import { validateDistributedGroupAssertions } from './distributed/group-assertions.ts';
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
 * A manifest from JSON: the schema checks its shape and every author setting, and the contract checks
 * the cross-field rules only once that shape holds.
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

    const manifest = value as RallarBlackBoxDistributedRunManifest;
    const contractIssues = validateDistributedRunManifestContract(manifest);
    return contractIssues.length === 0
        ? Either.ofRight(manifest)
        : Either.ofLeft(contractIssues.map((issue) => ({
            source: 'contract' as const,
            path: issue.path,
            message: issue.message
        })));
}

/** Every issue a typed manifest still has against the schema and contract; empty when it is valid. */
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

/** Cross-field rules a schema-valid manifest must also satisfy; empty when it does. */
export function validateDistributedRunManifestContract(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return [
        ...validateManifestIdentity(manifest),
        ...validateTargetPolicy(manifest),
        ...validateRoleAssignmentPolicy(manifest),
        ...validateStart(manifest),
        ...validateTimeouts(manifest),
        ...validateDistributedGroupAssertions(manifest)
    ];
}

function validateManifestIdentity(
    manifest: RallarBlackBoxDistributedRunManifest
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
    manifest: RallarBlackBoxDistributedRunManifest
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
    if (policy.mode !== 'selected-agents' && 'agentIds' in policy) {
        errors.push({
            path: '$.targetPolicy.agentIds',
            message: 'Only selected-agents target policies accept agentIds.'
        });
    }
    if (policy.mode !== 'role-map' && 'roles' in policy) {
        errors.push({ path: '$.targetPolicy.roles', message: 'Only role-map target policies accept roles.' });
    }
    if (policy.mode === 'selected-agents' && (!('agentIds' in policy) || policy.agentIds.length === 0)) {
        errors.push({
            path: '$.targetPolicy.agentIds',
            message: 'selected-agents target policy requires at least one agent ID.'
        });
    }
    if (policy.mode === 'role-map') {
        errors.push(...validateRoleMap(policy, manifest.roleAssignments));
    }
    return errors;
}

function validateRoleMap(
    policy: RallarBlackBoxDistributedRoleMapTargetPolicy,
    roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[]
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    if (!('roles' in policy)) {
        return [{ path: '$.targetPolicy.roles', message: 'A role-map target policy requires roles.' }];
    }
    const roleMapCount = Object.values(policy.roles).reduce((count, agentIds) => count + agentIds.length, 0);
    return roleMapCount === 0 && roleAssignments.length === 0
        ? [{ path: '$.targetPolicy.roles', message: 'role-map target policy requires roles or roleAssignments.' }]
        : [];
}

function validateRoleAssignmentPolicy(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const policy = manifest.roleAssignmentPolicy;
    if (policy === undefined) {
        return [];
    }
    return [
        ...(policy.mode === 'ordered-targets'
            ? []
            : [{
                path: '$.roleAssignmentPolicy.mode',
                message: 'Role assignment policy mode must be ordered-targets.'
            }]),
        ...(RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS.includes(policy.pattern)
            ? []
            : [{
                path: '$.roleAssignmentPolicy.pattern',
                message: 'Role assignment policy pattern is not supported.'
            }]),
        ...(RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS.includes(policy.orderBy)
            ? []
            : [{
                path: '$.roleAssignmentPolicy.orderBy',
                message: 'Role assignment policy ordering is not supported.'
            }])
    ];
}

function validateStart(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    if (manifest.startMode === 'scheduled') {
        return 'startDeadlineEpochMs' in manifest
            ? []
            : [{ path: '$.startDeadlineEpochMs', message: 'Scheduled distributed runs require startDeadlineEpochMs.' }];
    }
    return 'startDeadlineEpochMs' in manifest
        ? [{
            path: '$.startDeadlineEpochMs',
            message: 'Only scheduled distributed runs accept startDeadlineEpochMs.'
        }]
        : [];
}

function validateTimeouts(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const errors: RallarBlackBoxDistributedRunValidationIssue[] = [];
    if (!Number.isInteger(manifest.ackTimeoutMs) || manifest.ackTimeoutMs < 1) {
        errors.push({ path: '$.ackTimeoutMs', message: 'ACK timeout must be an integer >= 1.' });
    }
    const barrier = manifest.barrier;
    if (barrier.enabled && !('timeoutMs' in barrier)) {
        errors.push({ path: '$.barrier.timeoutMs', message: 'An enabled barrier requires timeoutMs.' });
    }
    else if (barrier.enabled && (!Number.isInteger(barrier.timeoutMs) || barrier.timeoutMs < 1)) {
        errors.push({ path: '$.barrier.timeoutMs', message: 'Barrier timeout must be an integer >= 1.' });
    }
    else if (!barrier.enabled && 'timeoutMs' in barrier) {
        errors.push({ path: '$.barrier.timeoutMs', message: 'A disabled barrier accepts no timeoutMs.' });
    }
    return errors;
}

function validateNonEmptyText(
    value: string,
    path: string
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return value.trim().length > 0 ? [] : [{ path, message: 'A non-empty string is required.' }];
}

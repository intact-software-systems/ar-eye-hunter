// deno-lint-ignore-file no-explicit-any
import { isRallarBlackBoxAssertOperator } from '../assert/assert-value-operators.ts';
import type { RallarBlackBoxTestAssertOperator } from '../types.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunValidationIssue,
} from '../distributed-run.ts';

export const RALLAR_BLACK_BOX_GROUP_ASSERTION_AGGREGATES = [
    'allMatch',
    'noneMatch',
    'countMatching',
    'allEqual',
    'allEqualWithin',
] as const;

export type RallarBlackBoxGroupAssertionAggregate =
    typeof RALLAR_BLACK_BOX_GROUP_ASSERTION_AGGREGATES[number];

export const RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED =
    'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED';

export const RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING =
    'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING';

export const RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS =
    'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS';

export type RallarBlackBoxGroupAssertionSource = Readonly<{
    recipeId: string;
    commandId: string;
    path: string;
}>;

export type RallarBlackBoxGroupAssertionScope = Readonly<{
    role: string;
}>;

export type RallarBlackBoxGroupAssertionPredicate = Readonly<{
    operator: RallarBlackBoxTestAssertOperator;
    expected?: any;
}>;

export type RallarBlackBoxGroupAssertionCountBounds = Readonly<{
    equals?: number;
    gte?: number;
    lte?: number;
}>;

type GroupAssertionCommon = Readonly<{
    groupAssertionId: string;
    description?: string;
    source: RallarBlackBoxGroupAssertionSource;
    scope?: RallarBlackBoxGroupAssertionScope;
    minParticipants?: number;
}>;

export type RallarBlackBoxDistributedGroupAssertion =
    | GroupAssertionCommon & Readonly<{
        aggregate: 'allMatch';
        predicate: RallarBlackBoxGroupAssertionPredicate;
    }>
    | GroupAssertionCommon & Readonly<{
        aggregate: 'noneMatch';
        predicate: RallarBlackBoxGroupAssertionPredicate;
    }>
    | GroupAssertionCommon & Readonly<{
        aggregate: 'countMatching';
        predicate: RallarBlackBoxGroupAssertionPredicate;
        count: RallarBlackBoxGroupAssertionCountBounds;
    }>
    | GroupAssertionCommon & Readonly<{ aggregate: 'allEqual' }>
    | GroupAssertionCommon & Readonly<{ aggregate: 'allEqualWithin'; tolerance: number }>;

export type RallarBlackBoxGroupAssertionEvidenceStatus =
    | 'resolved'
    | 'missing'
    | 'duplicate'
    | 'unresolved';

export type RallarBlackBoxGroupAssertionAgentRow = Readonly<{
    agentId: string;
    role?: string;
    evidence: RallarBlackBoxGroupAssertionEvidenceStatus;
    verdict?: 'matching' | 'not-matching' | 'violating' | 'agreeing';
    value?: any;
}>;

export type RallarBlackBoxDistributedGroupAssertionResult = Readonly<{
    groupAssertionId: string;
    aggregate: RallarBlackBoxGroupAssertionAggregate;
    ok: boolean;
    participants: Readonly<{
        expected: number;
        required: number;
        withEvidence: number;
        matching?: number;
    }>;
    missingAgentIds: readonly string[];
    violatingAgentIds: readonly string[];
    perAgent: readonly RallarBlackBoxGroupAssertionAgentRow[];
    error?: Readonly<{
        code: string;
        message: string;
        details?: any;
    }>;
}>;

export function validateDistributedGroupAssertions(
    manifest: RallarBlackBoxDistributedRunManifest,
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const groupAssertions = manifest.groupAssertions ?? [];
    const issues: RallarBlackBoxDistributedRunValidationIssue[] = [];
    const seenIds = new Set<string>();
    const recipeKeys = new Set(
        manifest.recipes
            .map(selection => selection.recipeId ?? selection.recipe?.recipeId ?? selection.role)
            .filter((key): key is string => typeof key === 'string' && key.trim().length > 0),
    );

    groupAssertions.forEach((assertion, index) => {
        const path = `$.groupAssertions[${index}]`;
        validateGroupAssertionIdentity({ assertion, path, seenIds }, issues);
        validateGroupAssertionSource({ assertion, path, manifest, recipeKeys }, issues);
        validateGroupAssertionScope({ assertion, path, manifest }, issues);
        validateGroupAssertionAggregate(assertion, path, issues);
    });

    return issues;
}

interface GroupAssertionIdentityValidationInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly path: string;
    readonly seenIds: Set<string>;
}

function validateGroupAssertionIdentity(
    input: GroupAssertionIdentityValidationInput,
    issues: RallarBlackBoxDistributedRunValidationIssue[],
): void {
    const id = input.assertion.groupAssertionId;
    if (typeof id !== 'string' || id.trim().length === 0) {
        issues.push({
            path: `${input.path}.groupAssertionId`,
            message: 'A non-empty string is required.',
        });
        return;
    }
    if (input.seenIds.has(id)) {
        issues.push({
            path: `${input.path}.groupAssertionId`,
            message: `Group assertion ID ${id} is duplicated; IDs must be unique.`,
        });
    }
    input.seenIds.add(id);
}

interface GroupAssertionSourceValidationInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly path: string;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly recipeKeys: ReadonlySet<string>;
}

function validateGroupAssertionSource(
    input: GroupAssertionSourceValidationInput,
    issues: RallarBlackBoxDistributedRunValidationIssue[],
): void {
    const source = input.assertion.source;
    for (const field of ['recipeId', 'commandId', 'path'] as const) {
        if (typeof source[field] !== 'string' || source[field].trim().length === 0) {
            issues.push({
                path: `${input.path}.source.${field}`,
                message: 'A non-empty string is required.',
            });
        }
    }
    if (!source.recipeId || !input.recipeKeys.has(source.recipeId)) {
        issues.push({
            path: `${input.path}.source.recipeId`,
            message: 'Source recipeId must reference a recipe selection in this manifest.',
        });
        return;
    }
    const inlineCommandIds = inlineRecipeCommandIds(input.manifest, source.recipeId);
    if (inlineCommandIds !== undefined && !inlineCommandIds.has(source.commandId)) {
        issues.push({
            path: `${input.path}.source.commandId`,
            message: 'Source commandId is not an authored commandId of the inline recipe.',
        });
    }
}

interface GroupAssertionScopeValidationInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly path: string;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
}

function validateGroupAssertionScope(
    input: GroupAssertionScopeValidationInput,
    issues: RallarBlackBoxDistributedRunValidationIssue[],
): void {
    const minParticipants = input.assertion.minParticipants;
    if (
        minParticipants !== undefined &&
        (!Number.isInteger(minParticipants) || minParticipants < 1)
    ) {
        issues.push({
            path: `${input.path}.minParticipants`,
            message: 'minParticipants must be an integer >= 1.',
        });
    }

    const role = input.assertion.scope?.role;
    if (role === undefined) {
        return;
    }
    if (typeof role !== 'string' || role.trim().length === 0) {
        issues.push({
            path: `${input.path}.scope.role`,
            message: 'A non-empty string is required.',
        });
        return;
    }
    const declaredRoles = new Set([
        ...(input.manifest.roleAssignments ?? []).map(assignment => assignment.role),
        ...Object.keys(input.manifest.targetPolicy.roles ?? {}),
    ]);
    if (declaredRoles.has(role)) {
        return;
    }
    // Pattern policies produce derived roles at target resolution; the frozen
    // participant set enforces unknown roles there as a no-participants failure.
    if (input.manifest.roleAssignmentPolicy !== undefined) {
        return;
    }
    issues.push({
        path: `${input.path}.scope.role`,
        message: `Scope role ${role} is not declared by roleAssignments or targetPolicy.roles.`,
    });
}

function validateGroupAssertionAggregate(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    path: string,
    issues: RallarBlackBoxDistributedRunValidationIssue[],
): void {
    if (assertion.aggregate === 'allEqualWithin') {
        if (typeof assertion.tolerance !== 'number' || !(assertion.tolerance >= 0)) {
            issues.push({
                path: `${path}.tolerance`,
                message: 'allEqualWithin requires a finite tolerance >= 0.',
            });
        }
        return;
    }
    if (assertion.aggregate === 'allEqual') {
        return;
    }
    if (!isRallarBlackBoxAssertOperator(assertion.predicate?.operator)) {
        issues.push({
            path: `${path}.predicate.operator`,
            message: 'Predicate operator is not a supported assert operator.',
        });
    }
    if (assertion.aggregate === 'countMatching') {
        validateGroupAssertionCountBounds(assertion.count, path, issues);
    }
}

function validateGroupAssertionCountBounds(
    count: RallarBlackBoxGroupAssertionCountBounds,
    path: string,
    issues: RallarBlackBoxDistributedRunValidationIssue[],
): void {
    const bounds = ['equals', 'gte', 'lte'] as const;
    if (!count || bounds.every(bound => count[bound] === undefined)) {
        issues.push({
            path: `${path}.count`,
            message: 'countMatching requires at least one of count.equals, count.gte, count.lte.',
        });
        return;
    }
    for (const bound of bounds) {
        const value = count[bound];
        if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
            issues.push({
                path: `${path}.count.${bound}`,
                message: `count.${bound} must be an integer >= 0.`,
            });
        }
    }
}

function inlineRecipeCommandIds(
    manifest: RallarBlackBoxDistributedRunManifest,
    recipeKey: string,
): ReadonlySet<string> | undefined {
    const selection = manifest.recipes.find(candidate =>
        (candidate.recipeId ?? candidate.recipe?.recipeId ?? candidate.role) === recipeKey
    );
    if (!selection?.recipe) {
        return undefined;
    }
    const commandIds = new Set<string>();
    const visit = (commands: readonly any[]): void => {
        for (const command of commands) {
            if (typeof command?.commandId === 'string') {
                commandIds.add(command.commandId);
            }
            if (Array.isArray(command?.commands)) {
                visit(command.commands);
            }
            if (Array.isArray(command?.groups)) {
                command.groups.forEach((group: any) => visit(group?.commands ?? []));
            }
            if (Array.isArray(command?.recipe?.commands)) {
                visit(command.recipe.commands);
            }
        }
    };
    visit(selection.recipe.commands);
    return commandIds;
}

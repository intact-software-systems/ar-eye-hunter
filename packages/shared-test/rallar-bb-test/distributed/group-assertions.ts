import { isRallarBlackBoxAssertOperator } from '../assert/assert-value-operators.ts';
import type { RallarBlackBoxDistributedRunValidationIssue } from '../distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../distributed-run.ts';
import type {
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestError,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';

export const RALLAR_BLACK_BOX_GROUP_ASSERTION_AGGREGATES = [
    'allMatch',
    'noneMatch',
    'countMatching',
    'allEqual',
    'allEqualWithin'
] as const;

export type RallarBlackBoxGroupAssertionAggregate = typeof RALLAR_BLACK_BOX_GROUP_ASSERTION_AGGREGATES[number];

export const RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED = 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED';

export const RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING =
    'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING';

export const RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS =
    'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS';

/** A value an agent's recipe result recorded, as a group assertion reads and compares it. */
export type RallarBlackBoxGroupAssertionValue = RallarBlackBoxTestResult['value'];

export interface RallarBlackBoxGroupAssertionSource {
    readonly recipeId: string;
    readonly commandId: string;
    readonly path: string;
}

export interface RallarBlackBoxGroupAssertionScope {
    readonly role: string;
}

export interface RallarBlackBoxGroupAssertionPredicate {
    readonly operator: RallarBlackBoxTestAssertOperator;
    /** Absent when the operator compares against no expected value, as `exists` does. */
    readonly expected?: RallarBlackBoxGroupAssertionValue;
}

export interface RallarBlackBoxGroupAssertionCountBounds {
    /** Absent when the matching count need not equal an exact number. */
    readonly equals?: number;
    /** Absent when the matching count has no lower bound. */
    readonly gte?: number;
    /** Absent when the matching count has no upper bound. */
    readonly lte?: number;
}

interface RallarBlackBoxGroupAssertionFields {
    readonly groupAssertionId: string;
    /** Absent when the author gives the assertion no description. */
    readonly description?: string;
    readonly source: RallarBlackBoxGroupAssertionSource;
    /** Absent when the assertion covers every frozen participant regardless of role. */
    readonly scope?: RallarBlackBoxGroupAssertionScope;
    /** Absent when every scoped participant must report usable evidence. */
    readonly minParticipants?: number;
}

export type RallarBlackBoxDistributedGroupAssertion =
    | RallarBlackBoxPredicateGroupAssertion
    | RallarBlackBoxCountMatchingGroupAssertion
    | RallarBlackBoxAllEqualGroupAssertion
    | RallarBlackBoxAllEqualWithinGroupAssertion;

export interface RallarBlackBoxPredicateGroupAssertion extends RallarBlackBoxGroupAssertionFields {
    readonly aggregate: 'allMatch' | 'noneMatch';
    readonly predicate: RallarBlackBoxGroupAssertionPredicate;
}

export interface RallarBlackBoxCountMatchingGroupAssertion extends RallarBlackBoxGroupAssertionFields {
    readonly aggregate: 'countMatching';
    readonly predicate: RallarBlackBoxGroupAssertionPredicate;
    readonly count: RallarBlackBoxGroupAssertionCountBounds;
}

export interface RallarBlackBoxAllEqualGroupAssertion extends RallarBlackBoxGroupAssertionFields {
    readonly aggregate: 'allEqual';
}

export interface RallarBlackBoxAllEqualWithinGroupAssertion extends RallarBlackBoxGroupAssertionFields {
    readonly aggregate: 'allEqualWithin';
    readonly tolerance: number;
}

export type RallarBlackBoxGroupAssertionEvidenceStatus =
    | 'resolved'
    | 'missing'
    | 'duplicate'
    | 'unresolved';

export interface RallarBlackBoxGroupAssertionAgentRow {
    readonly agentId: string;
    /** Absent when the participant holds no role. */
    readonly role?: string;
    readonly evidence: RallarBlackBoxGroupAssertionEvidenceStatus;
    /** Absent unless the participant's evidence resolved. */
    readonly verdict?: 'matching' | 'not-matching' | 'violating' | 'agreeing';
    /** Absent unless the participant's evidence resolved; redacted when it did. */
    readonly value?: RallarBlackBoxGroupAssertionValue;
}

export interface RallarBlackBoxGroupAssertionParticipantCounts {
    readonly expected: number;
    readonly required: number;
    readonly withEvidence: number;
    /** Absent for equality aggregates and for assertions with no participants, which count no matches. */
    readonly matching?: number;
}

export interface RallarBlackBoxDistributedGroupAssertionResult {
    readonly groupAssertionId: string;
    readonly aggregate: RallarBlackBoxGroupAssertionAggregate;
    readonly ok: boolean;
    readonly participants: RallarBlackBoxGroupAssertionParticipantCounts;
    readonly missingAgentIds: readonly string[];
    readonly violatingAgentIds: readonly string[];
    readonly perAgent: readonly RallarBlackBoxGroupAssertionAgentRow[];
    /** Absent when the assertion passed. */
    readonly error?: RallarBlackBoxTestError;
}

export function validateDistributedGroupAssertions(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const recipeKeys = new Set(
        manifest.recipes
            .map((selection) => selection.recipeId)
            .filter((key) => typeof key === 'string' && key.trim().length > 0)
    );
    const duplicatePositions = toDuplicateGroupAssertionIdPositions(manifest.groupAssertions);

    return manifest.groupAssertions.flatMap((assertion, index) => {
        const path = `$.groupAssertions[${index}]`;
        return [
            ...validateGroupAssertionIdentity(assertion, path, duplicatePositions.has(index)),
            ...validateGroupAssertionSource({ assertion, path, manifest, recipeKeys }),
            ...validateGroupAssertionScope({ assertion, path, manifest }),
            ...validateGroupAssertionAggregate(assertion, path)
        ];
    });
}

function toDuplicateGroupAssertionIdPositions(
    groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[]
): ReadonlySet<number> {
    const seenIds = new Set<string>();
    const positions = new Set<number>();
    groupAssertions.forEach((assertion, index) => {
        const id = assertion.groupAssertionId;
        if (typeof id !== 'string' || id.trim().length === 0) {
            return;
        }
        if (seenIds.has(id)) {
            positions.add(index);
        }
        seenIds.add(id);
    });
    return positions;
}

function validateGroupAssertionIdentity(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    path: string,
    duplicated: boolean
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const id = assertion.groupAssertionId;
    if (typeof id !== 'string' || id.trim().length === 0) {
        return [{ path: `${path}.groupAssertionId`, message: 'A non-empty string is required.' }];
    }
    return duplicated
        ? [{ path: `${path}.groupAssertionId`, message: `Group assertion ID ${id} is duplicated; IDs must be unique.` }]
        : [];
}

interface GroupAssertionSourceValidationInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly path: string;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly recipeKeys: ReadonlySet<string>;
}

function validateGroupAssertionSource(
    input: GroupAssertionSourceValidationInput
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const source = input.assertion.source;
    const fieldIssues = (['recipeId', 'commandId', 'path'] as const)
        .filter((field) => typeof source[field] !== 'string' || source[field].trim().length === 0)
        .map((field) => ({ path: `${input.path}.source.${field}`, message: 'A non-empty string is required.' }));
    if (!source.recipeId || !input.recipeKeys.has(source.recipeId)) {
        return [
            ...fieldIssues,
            {
                path: `${input.path}.source.recipeId`,
                message: 'Source recipeId must reference a recipe selection in this manifest.'
            }
        ];
    }
    const inlineCommandIds = toInlineRecipeCommandIds(input.manifest, source.recipeId);
    return inlineCommandIds !== undefined && !inlineCommandIds.has(source.commandId)
        ? [
            ...fieldIssues,
            {
                path: `${input.path}.source.commandId`,
                message: 'Source commandId is not an authored commandId of the inline recipe.'
            }
        ]
        : fieldIssues;
}

interface GroupAssertionScopeValidationInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly path: string;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
}

function validateGroupAssertionScope(
    input: GroupAssertionScopeValidationInput
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const minParticipants = input.assertion.minParticipants;
    const minParticipantIssues = minParticipants !== undefined &&
            (!Number.isInteger(minParticipants) || minParticipants < 1)
        ? [{ path: `${input.path}.minParticipants`, message: 'minParticipants must be an integer >= 1.' }]
        : [];

    const role = input.assertion.scope?.role;
    if (role === undefined) {
        return minParticipantIssues;
    }
    if (typeof role !== 'string' || role.trim().length === 0) {
        return [...minParticipantIssues, {
            path: `${input.path}.scope.role`,
            message: 'A non-empty string is required.'
        }];
    }
    const targetPolicy = input.manifest.targetPolicy;
    const declaredRoles = new Set([
        ...input.manifest.roleAssignments.map((assignment) => assignment.role),
        ...Object.keys(targetPolicy.mode === 'role-map' ? targetPolicy.roles : {})
    ]);
    // Pattern policies produce derived roles at target resolution; the frozen
    // participant set enforces unknown roles there as a no-participants failure.
    if (declaredRoles.has(role) || input.manifest.roleAssignmentPolicy !== undefined) {
        return minParticipantIssues;
    }
    return [
        ...minParticipantIssues,
        {
            path: `${input.path}.scope.role`,
            message: `Scope role ${role} is not declared by roleAssignments or targetPolicy.roles.`
        }
    ];
}

function validateGroupAssertionAggregate(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    path: string
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    if (assertion.aggregate === 'allEqualWithin') {
        return typeof assertion.tolerance !== 'number' || !(assertion.tolerance >= 0)
            ? [{ path: `${path}.tolerance`, message: 'allEqualWithin requires a finite tolerance >= 0.' }]
            : [];
    }
    if (assertion.aggregate === 'allEqual') {
        return [];
    }
    const operatorIssues = isRallarBlackBoxAssertOperator(assertion.predicate?.operator)
        ? []
        : [{ path: `${path}.predicate.operator`, message: 'Predicate operator is not a supported assert operator.' }];
    return assertion.aggregate === 'countMatching'
        ? [...operatorIssues, ...validateGroupAssertionCountBounds(assertion.count, path)]
        : operatorIssues;
}

function validateGroupAssertionCountBounds(
    count: RallarBlackBoxGroupAssertionCountBounds,
    path: string
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const bounds = ['equals', 'gte', 'lte'] as const;
    if (!count || bounds.every((bound) => count[bound] === undefined)) {
        return [{
            path: `${path}.count`,
            message: 'countMatching requires at least one of count.equals, count.gte, count.lte.'
        }];
    }
    return bounds
        .filter((bound) => {
            const value = count[bound];
            return value !== undefined && (!Number.isInteger(value) || value < 0);
        })
        .map((bound) => ({ path: `${path}.count.${bound}`, message: `count.${bound} must be an integer >= 0.` }));
}

function toInlineRecipeCommandIds(
    manifest: RallarBlackBoxDistributedRunManifest,
    recipeKey: string
): ReadonlySet<string> | undefined {
    const selection = manifest.recipes.find((candidate) => candidate.recipeId === recipeKey);
    if (!selection?.recipe) {
        return undefined;
    }
    const commandIds = new Set<string>();
    const pending: RallarBlackBoxTestCommand[] = [...selection.recipe.commands];
    for (let command = pending.shift(); command !== undefined; command = pending.shift()) {
        if (typeof command.commandId === 'string') {
            commandIds.add(command.commandId);
        }
        pending.push(...toNestedCommands(command));
    }
    return commandIds;
}

function toNestedCommands(command: RallarBlackBoxTestCommand): readonly RallarBlackBoxTestCommand[] {
    if (command.kind === 'loop') {
        return command.commands ?? [];
    }
    if (command.kind === 'parallel') {
        return (command.groups ?? []).flatMap((group) => group?.commands ?? []);
    }
    if (command.kind === 'recipe.load' || command.kind === 'recipe.run') {
        return command.recipe?.commands ?? [];
    }
    return [];
}

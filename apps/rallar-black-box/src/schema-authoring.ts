import { BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA } from '@shared-test/black-box-runner/schema.ts';
import { decodeDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxCommandCapability,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA
} from '@shared-test/rallar-bb-test/schema.ts';
import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
    type JsonSchema,
    type JsonSchemaValidationIssue
} from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from '@shared-test/rallar-bb-test/schema/rallar-black-box-command-capabilities.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { toError } from '@shared/resilience/to-error.ts';

export type SchemaAuthoringTarget =
    | 'command'
    | 'recipe'
    | 'distributed-run-manifest'
    | 'runner-scenario';

/**
 * A draft an author is checking: the JSON an editor parsed, or a value the caller already holds
 * in its typed form.
 */
export type SchemaAuthoringDraft = ApiJsonValue | object;

export type SchemaAuthoringValidation = Readonly<{
    target: SchemaAuthoringTarget;
    title: string;
    ok: boolean;
    parseOk: boolean;
    errors: readonly JsonSchemaValidationIssue[];
    /** Absent when the draft raised no schema issue. */
    errorText?: string;
    commandKinds: readonly RallarBlackBoxTestCommandKind[];
    capabilities: readonly RallarBlackBoxCommandCapability[];
    liveServiceRequirements: readonly string[];
    artifactExpectations: readonly string[];
    providerModes: readonly string[];
    runtimeSurfaces: readonly string[];
    distributedCompatible: boolean;
    /** The draft this validation read; absent when the author's text is not JSON. */
    parsed?: SchemaAuthoringDraft;
}>;

export type CommandExampleSnippet = Readonly<{
    kind: RallarBlackBoxTestCommandKind;
    title: string;
    description: string;
    commandText: string;
    providerModes: readonly string[];
    runtimeSurfaces: readonly string[];
    liveServiceRequirements: readonly string[];
    artifactExpectations: readonly string[];
    distributedCompatible: boolean;
}>;

const TARGET_TITLES: Readonly<Record<SchemaAuthoringTarget, string>> = {
    command: 'Command JSON',
    recipe: 'Recipe JSON',
    'distributed-run-manifest': 'Distributed Manifest',
    'runner-scenario': 'Runner Scenario'
};

const SCHEMAS: Readonly<Record<SchemaAuthoringTarget, JsonSchema>> = {
    command: RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    recipe: RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    'distributed-run-manifest': RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    'runner-scenario': BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA
};

const CAPABILITY_BY_KIND = new Map(
    RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map((capability) => [capability.kind, capability])
);

export function validateSchemaAuthoringText(
    target: SchemaAuthoringTarget,
    text: string
): SchemaAuthoringValidation {
    try {
        return validateSchemaAuthoringValue(target, JSON.parse(text) as ApiJsonValue);
    }
    catch (caught) {
        return toSchemaAuthoringValidation({
            target,
            parseOk: false,
            errors: [{ path: '$', message: toError(caught).message }],
            draft: undefined
        });
    }
}

export function validateSchemaAuthoringValue(
    target: SchemaAuthoringTarget,
    draft: SchemaAuthoringDraft
): SchemaAuthoringValidation {
    if (target === 'distributed-run-manifest') {
        const issues = decodeDistributedRunManifest(draft).left ?? [];
        return toSchemaAuthoringValidation({
            target,
            parseOk: true,
            errors: issues.map(({ path, message }) => ({ path, message })),
            draft
        });
    }

    const schemaResult = validateJsonSchema(SCHEMAS[target], draft);
    return toSchemaAuthoringValidation({
        target,
        parseOk: true,
        errors: schemaResult.ok ? [] : schemaResult.errors,
        draft
    });
}

export function toCommandExampleSnippets(): readonly CommandExampleSnippet[] {
    return RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map((capability) => ({
        kind: capability.kind,
        title: capability.title,
        description: capability.description,
        commandText: JSON.stringify(capability.example, null, 2),
        providerModes: capability.supportedProviderModes,
        runtimeSurfaces: capability.runtimeSurfaces,
        liveServiceRequirements: capability.liveServiceRequirements,
        artifactExpectations: capability.artifactExpectations,
        distributedCompatible: capability.runtimeSurfaces.includes('control-agent')
    }));
}

export function toSchemaAuthoringTone(validation: SchemaAuthoringValidation): string {
    if (!validation.parseOk || !validation.ok) {
        return 'bad';
    }
    if (validation.liveServiceRequirements.length > 0) {
        return 'warn';
    }
    return 'good';
}

export function toSchemaAuthoringSummary(validation: SchemaAuthoringValidation): string {
    if (!validation.parseOk) {
        return 'invalid JSON';
    }
    if (!validation.ok) {
        return `${validation.errors.length} schema issue${validation.errors.length === 1 ? '' : 's'}`;
    }
    const commandSummary = validation.commandKinds.length > 0
        ? `${validation.commandKinds.length} command kind${validation.commandKinds.length === 1 ? '' : 's'}`
        : 'schema valid';
    return validation.liveServiceRequirements.length > 0
        ? `${commandSummary}, live requirements`
        : commandSummary;
}

interface ToSchemaAuthoringValidationInput {
    readonly target: SchemaAuthoringTarget;
    readonly parseOk: boolean;
    readonly errors: readonly JsonSchemaValidationIssue[];
    /** The draft that was checked, or `undefined` when the author's text is not JSON. */
    readonly draft: SchemaAuthoringDraft | undefined;
}

function toSchemaAuthoringValidation(
    input: ToSchemaAuthoringValidationInput
): SchemaAuthoringValidation {
    const { target, parseOk, errors, draft } = input;
    const commandKinds = parseOk ? toCommandKindsForDraft(target, draft) : [];
    const capabilities = commandKinds
        .map((kind) => CAPABILITY_BY_KIND.get(kind))
        .filter((capability): capability is RallarBlackBoxCommandCapability => Boolean(capability));

    return {
        target,
        title: TARGET_TITLES[target],
        ok: parseOk && errors.length === 0,
        parseOk,
        errors,
        errorText: errors.length > 0 ? formatJsonSchemaValidationErrors(errors) : undefined,
        commandKinds,
        capabilities,
        liveServiceRequirements: toSortedDistinctValues(
            capabilities.flatMap((capability) => capability.liveServiceRequirements)
        ),
        artifactExpectations: toSortedDistinctValues(
            capabilities.flatMap((capability) => capability.artifactExpectations)
        ),
        providerModes: toSortedDistinctValues(
            capabilities.flatMap((capability) => capability.supportedProviderModes)
        ),
        runtimeSurfaces: toSortedDistinctValues(capabilities.flatMap((capability) => capability.runtimeSurfaces)),
        distributedCompatible: capabilities.length > 0 &&
            capabilities.every((capability) => capability.runtimeSurfaces.includes('control-agent')),
        parsed: draft
    };
}

function toCommandKindsForDraft(
    target: SchemaAuthoringTarget,
    draft: SchemaAuthoringDraft | undefined
): readonly RallarBlackBoxTestCommandKind[] {
    if (target === 'command') {
        return isCommand(draft) ? toCommandKindsForCommand(draft) : [];
    }
    if (target === 'recipe') {
        return isRecipe(draft)
            ? toSortedDistinctValues(draft.commands.flatMap(toCommandKindsForCommand))
            : [];
    }
    if (target === 'distributed-run-manifest') {
        if (!isDistributedManifest(draft)) {
            return [];
        }
        return toSortedDistinctValues(
            draft.recipes.flatMap((selection) => selection.recipe?.commands.flatMap(toCommandKindsForCommand) ?? [])
        );
    }
    return [];
}

function toCommandKindsForCommand(command: RallarBlackBoxTestCommand): readonly RallarBlackBoxTestCommandKind[] {
    const nested = toNestedCommandKinds(command);
    return toSortedDistinctValues([command.kind, ...nested]);
}

function toNestedCommandKinds(
    command: RallarBlackBoxTestCommand
): readonly RallarBlackBoxTestCommandKind[] {
    switch (command.kind) {
        case 'loop':
            return command.commands.flatMap(toCommandKindsForCommand);
        case 'parallel':
            return command.groups.flatMap((group) => group.commands.flatMap(toCommandKindsForCommand));
        case 'recipe.load':
        case 'recipe.run':
            return command.recipe?.commands.flatMap(toCommandKindsForCommand) ?? [];
        default:
            return [];
    }
}

function isCommand(value: unknown): value is RallarBlackBoxTestCommand {
    return isJsonObject(value) && typeof value.kind === 'string';
}

function isRecipe(value: unknown): value is RallarBlackBoxTestRecipe {
    return isJsonObject(value) &&
        typeof value.recipeId === 'string' &&
        Array.isArray(value.commands) &&
        value.commands.every(isCommand);
}

function isDistributedManifest(value: unknown): value is RallarBlackBoxDistributedRunManifest {
    return isJsonObject(value) &&
        typeof value.distributedRunId === 'string' &&
        Array.isArray(value.recipes);
}

function toSortedDistinctValues<T extends string>(values: readonly (T | undefined)[]): readonly T[] {
    return [...new Set(values.filter((value): value is T => Boolean(value)))].sort();
}

function isJsonObject(value: unknown): value is ApiJsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

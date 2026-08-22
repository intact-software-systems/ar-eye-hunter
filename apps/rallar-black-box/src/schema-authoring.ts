import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_COMMAND_CAPABILITIES,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    validateJsonSchema,
    type JsonSchema,
    type JsonSchemaValidationIssue,
    type RallarBlackBoxCommandCapability
} from '@shared-test/rallar-bb-test/schema.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/types.ts';
import { RALLAR_BLACK_BOX_SHARED_TEST_RUNNER_SCENARIO_SCHEMA } from './shared-test-handoff-fixtures.ts';

export type SchemaAuthoringTarget =
    | 'command'
    | 'recipe'
    | 'distributed-run-manifest'
    | 'runner-scenario';

export type SchemaAuthoringValidation = Readonly<{
    target: SchemaAuthoringTarget;
    title: string;
    ok: boolean;
    parseOk: boolean;
    errors: readonly JsonSchemaValidationIssue[];
    errorText?: string;
    commandKinds: readonly RallarBlackBoxTestCommandKind[];
    capabilities: readonly RallarBlackBoxCommandCapability[];
    liveServiceRequirements: readonly string[];
    artifactExpectations: readonly string[];
    providerModes: readonly string[];
    runtimeSurfaces: readonly string[];
    distributedCompatible: boolean;
    parsed?: unknown;
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
    'runner-scenario': RALLAR_BLACK_BOX_SHARED_TEST_RUNNER_SCENARIO_SCHEMA
};

const CAPABILITY_BY_KIND = new Map(
    RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map((capability) => [capability.kind, capability])
);

export function validateSchemaAuthoringText(
    target: SchemaAuthoringTarget,
    text: string
): SchemaAuthoringValidation {
    try {
        return validateSchemaAuthoringValue(target, JSON.parse(text) as unknown);
    }
    catch (caught) {
        return validationFromErrors(target, false, [{
            path: '$',
            message: caught instanceof Error ? caught.message : String(caught)
        }], undefined);
    }
}

export function validateSchemaAuthoringValue(
    target: SchemaAuthoringTarget,
    value: unknown
): SchemaAuthoringValidation {
    const schemaResult = validateJsonSchema(SCHEMAS[target], value);
    const errors: JsonSchemaValidationIssue[] = schemaResult.ok ? [] : [...schemaResult.errors];

    if (target === 'distributed-run-manifest' && schemaResult.ok) {
        const contractResult = validateDistributedRunManifestContract(value as RallarBlackBoxDistributedRunManifest);
        if (!contractResult.ok) {
            errors.push(...contractResult.errors);
        }
    }

    return validationFromErrors(target, true, errors, value);
}

export function commandExampleSnippets(): readonly CommandExampleSnippet[] {
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

export function schemaAuthoringTone(validation: SchemaAuthoringValidation): string {
    if (!validation.parseOk || !validation.ok) {
        return 'bad';
    }
    if (validation.liveServiceRequirements.length > 0) {
        return 'warn';
    }
    return 'good';
}

export function schemaAuthoringSummary(validation: SchemaAuthoringValidation): string {
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

function validationFromErrors(
    target: SchemaAuthoringTarget,
    parseOk: boolean,
    errors: readonly JsonSchemaValidationIssue[],
    parsed: unknown
): SchemaAuthoringValidation {
    const commandKinds = parseOk ? commandKindsForValue(target, parsed) : [];
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
        liveServiceRequirements: uniqueValues(capabilities.flatMap((capability) => capability.liveServiceRequirements)),
        artifactExpectations: uniqueValues(capabilities.flatMap((capability) => capability.artifactExpectations)),
        providerModes: uniqueValues(capabilities.flatMap((capability) => capability.supportedProviderModes)),
        runtimeSurfaces: uniqueValues(capabilities.flatMap((capability) => capability.runtimeSurfaces)),
        distributedCompatible: capabilities.length > 0 &&
            capabilities.every((capability) => capability.runtimeSurfaces.includes('control-agent')),
        parsed
    };
}

function commandKindsForValue(
    target: SchemaAuthoringTarget,
    value: unknown
): readonly RallarBlackBoxTestCommandKind[] {
    if (target === 'command') {
        return isCommand(value) ? commandKindsForCommand(value) : [];
    }
    if (target === 'recipe') {
        return isRecipe(value)
            ? uniqueValues(value.commands.flatMap(commandKindsForCommand))
            : [];
    }
    if (target === 'distributed-run-manifest') {
        if (!isDistributedManifest(value)) {
            return [];
        }
        return uniqueValues(
            value.recipes.flatMap((selection) => selection.recipe?.commands.flatMap(commandKindsForCommand) ?? [])
        );
    }
    return [];
}

function commandKindsForCommand(command: RallarBlackBoxTestCommand): readonly RallarBlackBoxTestCommandKind[] {
    const nested = (() => {
        switch (command.kind) {
            case 'loop':
                return command.commands.flatMap(commandKindsForCommand);
            case 'parallel':
                return command.groups.flatMap((group) => group.commands.flatMap(commandKindsForCommand));
            case 'recipe.load':
            case 'recipe.run':
                return command.recipe?.commands.flatMap(commandKindsForCommand) ?? [];
            default:
                return [];
        }
    })();

    return uniqueValues([command.kind, ...nested]);
}

function isCommand(value: unknown): value is RallarBlackBoxTestCommand {
    return isRecord(value) && typeof value.kind === 'string';
}

function isRecipe(value: unknown): value is RallarBlackBoxTestRecipe {
    return isRecord(value) &&
        typeof value.recipeId === 'string' &&
        Array.isArray(value.commands) &&
        value.commands.every(isCommand);
}

function isDistributedManifest(value: unknown): value is RallarBlackBoxDistributedRunManifest {
    return isRecord(value) &&
        typeof value.distributedRunId === 'string' &&
        Array.isArray(value.recipes);
}

function uniqueValues<T extends string>(values: readonly (T | undefined)[]): readonly T[] {
    return [...new Set(values.filter((value): value is T => Boolean(value)))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

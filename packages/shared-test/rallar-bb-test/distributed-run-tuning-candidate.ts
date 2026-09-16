import { validateRallarBlackBoxTestCommand } from './control/validate-rallar-black-box-test-command.ts';
import { distributedRecipePreflight } from './distributed-recipe-preflight/distributed-recipe-preflight.ts';
import {
    tuningAgentIssuePointer,
    tuningPointerTargetsObject,
    tuningPointerTokens,
    tuningPreflightIssuePointer,
    tuningSchemaPathToPointer
} from './distributed-run-tuning-paths.ts';
import { inventoryDistributedRunTuningKnobs, type DistributedRunTuningKnob } from './distributed-run-tuning.ts';
import { validateDistributedRunManifest } from './distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from './distributed-run.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from './schema.ts';
import { isJsonRecordValue, validateJsonSchema } from './schema/json-schema-validation.ts';

export interface DistributedRunTuningChange {
    readonly pointer: string;
    readonly value: number;
    readonly expectedValue?: number | null;
}
export interface DistributedRunTuningPatchOperation {
    readonly op: 'add' | 'replace';
    readonly path: string;
    readonly value: unknown;
}
export interface DistributedRunTuningDiffRow {
    readonly pointer: string;
    readonly before?: number;
    readonly after: number;
}

export type DistributedRunTuningCandidateErrorCode =
    | 'unknown-pointer'
    | 'duplicate-pointer'
    | 'stale-value'
    | 'blocked-knob'
    | 'invalid-value'
    | 'clone-failed'
    | 'patch-application'
    | 'manifest-validation'
    | 'recipe-validation'
    | 'agent-validation'
    | 'preflight-validation';

export interface DistributedRunTuningCandidateError {
    readonly code: DistributedRunTuningCandidateErrorCode;
    readonly path?: string;
    readonly message: string;
}
export type DistributedRunTuningCandidateResult =
    | Readonly<{
        ok: true;
        manifest: RallarBlackBoxDistributedRunManifest;
        patch: readonly DistributedRunTuningPatchOperation[];
        patchJson: string;
        diff: readonly DistributedRunTuningDiffRow[];
        diffText: string;
    }>
    | Readonly<{ ok: false; errors: readonly DistributedRunTuningCandidateError[]; }>;

type PatchedTuningManifestResult =
    | Readonly<{ ok: true; manifest: RallarBlackBoxDistributedRunManifest; }>
    | Extract<DistributedRunTuningCandidateResult, { ok: false; }>;

interface AcceptedChange {
    readonly change: DistributedRunTuningChange;
    readonly knob: DistributedRunTuningKnob;
    readonly index: number;
}

type TuningChangeOutcome =
    | Readonly<{ ok: true; accepted: AcceptedChange; }>
    | Readonly<{ ok: false; error: DistributedRunTuningCandidateError; }>;

export function createDistributedRunTuningCandidate(
    input: Readonly<{ manifest: RallarBlackBoxDistributedRunManifest; changes: readonly DistributedRunTuningChange[]; }>
): DistributedRunTuningCandidateResult {
    const sourceErrors = toTuningManifestValidationErrors(input.manifest);
    if (sourceErrors.length > 0) {
        return { ok: false, errors: sourceErrors };
    }
    const changes = toAcceptedTuningChanges(input);
    if (!changes.ok) {
        return changes;
    }
    const accepted = changes.accepted;
    const patch = toTuningPatch(input.manifest, accepted);
    const cloned = createPatchedTuningManifest(input.manifest, patch);
    if (!cloned.ok) {
        return cloned;
    }
    const validationErrors = toTuningManifestValidationErrors(cloned.manifest);
    if (validationErrors.length > 0) {
        return { ok: false, errors: validationErrors };
    }
    const diff = accepted.map(({ change, knob }) => ({
        pointer: change.pointer,
        before: knob.currentValue,
        after: change.value
    }));
    return {
        ok: true,
        manifest: cloned.manifest,
        patch,
        patchJson: JSON.stringify(patch, null, 2),
        diff,
        diffText: diff.map((row) => `${row.pointer}: ${toDisplayValue(row.before)} -> ${toDisplayValue(row.after)}`)
            .join('\n')
    };
}
function toAcceptedTuningChanges(
    input: Readonly<{ manifest: RallarBlackBoxDistributedRunManifest; changes: readonly DistributedRunTuningChange[]; }>
): { readonly ok: true; readonly accepted: readonly AcceptedChange[]; } | {
    readonly ok: false;
    readonly errors: readonly DistributedRunTuningCandidateError[];
} {
    const inventory = inventoryDistributedRunTuningKnobs(input.manifest);
    const knobByPointer = new Map(inventory.knobs.map((knob, index) => [knob.pointer, { knob, index }]));
    const seenPointers = new Set<string>();
    const errors: DistributedRunTuningCandidateError[] = [];
    const accepted: AcceptedChange[] = [];
    for (const change of input.changes) {
        const outcome = toTuningChangeOutcome({ change, knobByPointer, seenPointers });
        if (outcome.ok) {
            accepted.push(outcome.accepted);
        }
        else {
            errors.push(outcome.error);
        }
    }
    accepted.sort((left, right) => left.index - right.index);
    return errors.length ? { ok: false, errors } : { ok: true, accepted };
}
function toTuningChangeOutcome(
    input: Readonly<{
        change: DistributedRunTuningChange;
        knobByPointer: ReadonlyMap<string, { readonly knob: DistributedRunTuningKnob; readonly index: number; }>;
        seenPointers: Set<string>;
    }>
): TuningChangeOutcome {
    const { change, knobByPointer, seenPointers } = input;
    if (seenPointers.has(change.pointer)) {
        return {
            ok: false,
            error: toCandidateError(
                'duplicate-pointer',
                change.pointer,
                'A tuning candidate may change each knob pointer only once.'
            )
        };
    }
    seenPointers.add(change.pointer);
    const entry = knobByPointer.get(change.pointer);
    if (!entry) {
        return {
            ok: false,
            error: toCandidateError(
                'unknown-pointer',
                change.pointer,
                'The path is not an inventory-approved tuning knob.'
            )
        };
    }
    const error = toTuningChangeError(change, entry.knob);
    return error ? { ok: false, error } : { ok: true, accepted: { change, ...entry } };
}
function toTuningChangeError(
    change: DistributedRunTuningChange,
    knob: DistributedRunTuningKnob
): DistributedRunTuningCandidateError | undefined {
    if (knob.availability === 'blocked' || !knob.effective) {
        return toCandidateError(
            'blocked-knob',
            change.pointer,
            knob.reason ?? 'The tuning knob is not effective for this manifest.'
        );
    }
    if (Object.hasOwn(change, 'expectedValue')) {
        const expected = change.expectedValue === null ? undefined : change.expectedValue;
        if (!Object.is(expected, knob.currentValue)) {
            return toCandidateError(
                'stale-value',
                change.pointer,
                `Expected ${toDisplayValue(expected)}, but the manifest contains ${toDisplayValue(knob.currentValue)}.`
            );
        }
    }
    const error = toTuningValueError(change.value, knob);
    return error ? toCandidateError('invalid-value', change.pointer, error) : undefined;
}
function createPatchedTuningManifest(
    manifest: RallarBlackBoxDistributedRunManifest,
    patch: readonly DistributedRunTuningPatchOperation[]
): PatchedTuningManifestResult {
    const cloned = toClonedTuningManifest(manifest);
    return cloned.ok ? toPatchedTuningManifestCandidate(cloned.manifest, patch) : cloned;
}
function toClonedTuningManifest(manifest: RallarBlackBoxDistributedRunManifest): PatchedTuningManifestResult {
    try {
        return { ok: true, manifest: structuredClone(manifest) };
    }
    catch (error) {
        return {
            ok: false,
            errors: [
                toCandidateError(
                    'clone-failed',
                    undefined,
                    `Unable to clone the source manifest: ${toErrorMessage(error)}`
                )
            ]
        };
    }
}
function toPatchedTuningManifestCandidate(
    candidate: RallarBlackBoxDistributedRunManifest,
    patch: readonly DistributedRunTuningPatchOperation[]
): PatchedTuningManifestResult {
    try {
        const error = applyPatch(candidate, patch);
        return error
            ? {
                ok: false,
                errors: [toCandidateError('patch-application', undefined, `Unable to apply candidate patch: ${error}`)]
            }
            : { ok: true, manifest: candidate };
    }
    catch (error) {
        return {
            ok: false,
            errors: [
                toCandidateError(
                    'patch-application',
                    undefined,
                    `Unable to apply candidate patch: ${toErrorMessage(error)}`
                )
            ]
        };
    }
}

function toTuningPatch(
    manifest: RallarBlackBoxDistributedRunManifest,
    accepted: readonly AcceptedChange[]
): readonly DistributedRunTuningPatchOperation[] {
    const patch: DistributedRunTuningPatchOperation[] = [];
    const materializedParents = new Set<string>();
    for (const { change, knob } of accepted) {
        if (knob.scope === 'stream-threshold') {
            const parent = change.pointer.slice(0, change.pointer.lastIndexOf('/'));
            if (!tuningPointerTargetsObject(manifest, parent) && !materializedParents.has(parent)) {
                patch.push({ op: 'add', path: parent, value: {} });
                materializedParents.add(parent);
            }
        }
        patch.push({
            op: knob.currentValue === undefined ? 'add' : 'replace',
            path: change.pointer,
            value: change.value
        });
    }
    return patch;
}

function toTuningValueError(value: number, knob: DistributedRunTuningKnob): string | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'Candidate value must be a finite number.';
    }
    const constraint = knob.constraint;
    if (constraint.type === 'integer' && !Number.isInteger(value)) {
        return 'Candidate value must be an integer.';
    }
    if (constraint.minimum !== undefined && value < constraint.minimum) {
        return `Candidate value must be >= ${constraint.minimum}.`;
    }
    if (constraint.exclusiveMinimum !== undefined && value <= constraint.exclusiveMinimum) {
        return `Candidate value must be > ${constraint.exclusiveMinimum}.`;
    }
    if (constraint.maximum !== undefined && value > constraint.maximum) {
        return `Candidate value must be <= ${constraint.maximum}.`;
    }
    return undefined;
}

function toTuningManifestValidationErrors(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly DistributedRunTuningCandidateError[] {
    const errors: DistributedRunTuningCandidateError[] = [];
    try {
        const validation = validateDistributedRunManifest(manifest);
        errors.push(...validation.errors.map((error) =>
            toCandidateError(
                'manifest-validation',
                tuningSchemaPathToPointer(error.path),
                error.message
            )
        ));
    }
    catch (error) {
        errors.push(toCandidateError('manifest-validation', '/', toErrorMessage(error)));
    }
    let selections: RallarBlackBoxDistributedRunManifest['recipes'];
    try {
        const value = manifest.recipes;
        if (!Array.isArray(value) || !value.every(isJsonRecordValue)) {
            return errors;
        }
        selections = value;
    }
    catch (error) {
        errors.push(toCandidateError('manifest-validation', '/recipes', toErrorMessage(error)));
        return errors;
    }
    selections.forEach((selection, recipeIndex) => {
        if (selection.recipe) {
            errors.push(...toRecipeTuningValidationErrors(selection.recipe, `/recipes/${recipeIndex}/recipe`));
        }
    });
    return errors;
}

function applyPatch(
    manifest: RallarBlackBoxDistributedRunManifest,
    patch: readonly DistributedRunTuningPatchOperation[]
): string | undefined {
    for (const operation of patch) {
        const tokens = tuningPointerTokens(operation.path);
        const key = tokens.pop();
        if (key === undefined) {
            return `Invalid patch path ${operation.path}.`;
        }
        let parent: unknown = manifest;
        for (const token of tokens) {
            if (Array.isArray(parent)) {
                parent = parent[Number(token)];
            }
            else if (isJsonRecordValue(parent)) {
                parent = parent[token];
            }
            else {
                return 'Patch path parent is not an object.';
            }
        }
        if (!isJsonRecordValue(parent)) {
            return 'Patch path parent is not an object.';
        }
        if (operation.op === 'replace' && !Object.hasOwn(parent, key)) {
            return `Replace target ${operation.path} does not exist.`;
        }
        parent[key] = structuredClone(operation.value);
    }
    return undefined;
}

function toCandidateError(
    code: DistributedRunTuningCandidateErrorCode,
    path: string | undefined,
    message: string
): DistributedRunTuningCandidateError {
    return { code, path, message };
}

function toDisplayValue(value: number | undefined): string {
    return value === undefined ? '(unset)' : String(value);
}
function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

type TuningRecipe = NonNullable<RallarBlackBoxDistributedRunManifest['recipes'][number]['recipe']>;

function toRecipeTuningValidationErrors(
    recipe: TuningRecipe,
    basePath: string
): readonly DistributedRunTuningCandidateError[] {
    return [
        ...toRecipeSchemaTuningErrors(recipe, basePath),
        ...toRecipeAgentTuningErrors(recipe, basePath),
        ...toRecipePreflightTuningErrors(recipe, basePath)
    ];
}
function toRecipeSchemaTuningErrors(
    recipe: TuningRecipe,
    basePath: string
): readonly DistributedRunTuningCandidateError[] {
    try {
        const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe);
        return validation.errors.map((error) =>
            toCandidateError(
                'recipe-validation',
                `${basePath}${tuningSchemaPathToPointer(error.path)}`,
                error.message
            )
        );
    }
    catch (error) {
        return [toCandidateError('recipe-validation', basePath, toErrorMessage(error))];
    }
}
function toRecipeAgentTuningErrors(
    recipe: TuningRecipe,
    basePath: string
): readonly DistributedRunTuningCandidateError[] {
    try {
        const agent = validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe });
        return agent.ok
            ? []
            : agent.messages.map((message) =>
                toCandidateError('agent-validation', tuningAgentIssuePointer(basePath, message), message)
            );
    }
    catch (error) {
        return [toCandidateError('agent-validation', basePath, toErrorMessage(error))];
    }
}
function toRecipePreflightTuningErrors(
    recipe: TuningRecipe,
    basePath: string
): readonly DistributedRunTuningCandidateError[] {
    try {
        const preflight = distributedRecipePreflight(recipe);
        return preflight.errors.map((message) =>
            toCandidateError('preflight-validation', tuningPreflightIssuePointer(basePath, message), message)
        );
    }
    catch (error) {
        return [toCandidateError('preflight-validation', basePath, toErrorMessage(error))];
    }
}

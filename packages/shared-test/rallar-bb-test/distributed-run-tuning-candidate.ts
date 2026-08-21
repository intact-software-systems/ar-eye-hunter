import { validateRallarBlackBoxTestCommand } from './control-protocol.ts';
import { distributedRecipePreflight } from './distributed-run-monitor.ts';
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
import { validateRallarBlackBoxRecipeCompatibility } from './schema.ts';

export type DistributedRunTuningChange = Readonly<{
    pointer: string;
    value: number;
    expectedValue?: number | null;
}>;
export type DistributedRunTuningPatchOperation = Readonly<{
    op: 'add' | 'replace';
    path: string;
    value: unknown;
}>;
export type DistributedRunTuningDiffRow = Readonly<{
    pointer: string;
    before?: number;
    after: number;
}>;

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

export type DistributedRunTuningCandidateError = Readonly<{
    code: DistributedRunTuningCandidateErrorCode;
    path?: string;
    message: string;
}>;
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

type AcceptedChange = Readonly<{
    change: DistributedRunTuningChange;
    knob: DistributedRunTuningKnob;
    index: number;
}>;

export function createDistributedRunTuningCandidate(
    input: Readonly<{
        manifest: RallarBlackBoxDistributedRunManifest;
        changes: readonly DistributedRunTuningChange[];
    }>
): DistributedRunTuningCandidateResult {
    const sourceErrors = tuningManifestValidationErrors(input.manifest);
    if (sourceErrors.length > 0) {
        return { ok: false, errors: sourceErrors };
    }

    const inventory = inventoryDistributedRunTuningKnobs(input.manifest);
    const knobByPointer = new Map(inventory.knobs.map((knob, index) => [
        knob.pointer,
        { knob, index }
    ]));
    const errors: DistributedRunTuningCandidateError[] = [];
    const seenPointers = new Set<string>();
    const accepted: AcceptedChange[] = [];

    for (const change of input.changes) {
        if (seenPointers.has(change.pointer)) {
            errors.push(candidateError(
                'duplicate-pointer',
                change.pointer,
                'A tuning candidate may change each knob pointer only once.'
            ));
            continue;
        }
        seenPointers.add(change.pointer);
        const inventoryEntry = knobByPointer.get(change.pointer);
        if (!inventoryEntry) {
            errors.push(candidateError(
                'unknown-pointer',
                change.pointer,
                'The path is not an inventory-approved tuning knob.'
            ));
            continue;
        }
        const { knob, index } = inventoryEntry;
        if (knob.availability === 'blocked' || !knob.effective) {
            errors.push(candidateError(
                'blocked-knob',
                change.pointer,
                knob.reason ?? 'The tuning knob is not effective for this manifest.'
            ));
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(change, 'expectedValue')) {
            const expected = change.expectedValue === null ? undefined : change.expectedValue;
            if (!Object.is(expected, knob.currentValue)) {
                errors.push(candidateError(
                    'stale-value',
                    change.pointer,
                    `Expected ${displayValue(expected)}, but the manifest contains ${displayValue(knob.currentValue)}.`
                ));
                continue;
            }
        }
        const valueError = tuningValueError(change.value, knob);
        if (valueError) {
            errors.push(candidateError('invalid-value', change.pointer, valueError));
            continue;
        }
        accepted.push({ change, knob, index });
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }

    accepted.sort((left, right) => left.index - right.index);
    const patch = tuningPatch(input.manifest, accepted);
    let candidate: RallarBlackBoxDistributedRunManifest;
    try {
        candidate = structuredClone(input.manifest);
    }
    catch (error) {
        return {
            ok: false,
            errors: [candidateError(
                'clone-failed',
                undefined,
                `Unable to clone the source manifest: ${errorMessage(error)}`
            )]
        };
    }
    try {
        applyPatch(candidate, patch);
    }
    catch (error) {
        return {
            ok: false,
            errors: [candidateError(
                'patch-application',
                undefined,
                `Unable to apply candidate patch: ${errorMessage(error)}`
            )]
        };
    }

    const validationErrors = tuningManifestValidationErrors(candidate);
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
        manifest: candidate,
        patch,
        patchJson: JSON.stringify(patch, null, 2),
        diff,
        diffText: diff.map((row) => `${row.pointer}: ${displayValue(row.before)} -> ${displayValue(row.after)}`).join(
            '\n'
        )
    };
}

function tuningPatch(
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

function tuningValueError(value: number, knob: DistributedRunTuningKnob): string | undefined {
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

function tuningManifestValidationErrors(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly DistributedRunTuningCandidateError[] {
    const errors: DistributedRunTuningCandidateError[] = [];
    try {
        const validation = validateDistributedRunManifest(manifest);
        errors.push(...validation.errors.map((error) =>
            candidateError(
                'manifest-validation',
                tuningSchemaPathToPointer(error.path),
                error.message
            )
        ));
    }
    catch (error) {
        errors.push(candidateError('manifest-validation', '/', errorMessage(error)));
    }
    let selections: readonly Record<string, unknown>[];
    try {
        const value = (manifest as unknown as Record<string, unknown>).recipes;
        if (!Array.isArray(value) || !value.every(isRecord)) {
            return errors;
        }
        selections = value;
    }
    catch (error) {
        errors.push(candidateError('manifest-validation', '/recipes', errorMessage(error)));
        return errors;
    }
    selections.forEach((selection, recipeIndex) => {
        if (!selection.recipe) {
            return;
        }
        const recipe = selection.recipe as RallarBlackBoxDistributedRunManifest['recipes'][number]['recipe'];
        if (!recipe) {
            return;
        }
        const basePath = `/recipes/${recipeIndex}/recipe`;
        try {
            const compatibility = validateRallarBlackBoxRecipeCompatibility(recipe);
            errors.push(...compatibility.errors.map((error) =>
                candidateError(
                    'recipe-validation',
                    `${basePath}${tuningSchemaPathToPointer(error.path)}`,
                    error.message
                )
            ));
        }
        catch (error) {
            errors.push(candidateError('recipe-validation', basePath, errorMessage(error)));
        }
        try {
            const agent = validateRallarBlackBoxTestCommand({
                kind: 'recipe.load',
                recipe
            });
            if (!agent.ok) {
                errors.push(candidateError(
                    'agent-validation',
                    tuningAgentIssuePointer(basePath, agent.error),
                    agent.error
                ));
            }
        }
        catch (error) {
            errors.push(candidateError('agent-validation', basePath, errorMessage(error)));
        }
        try {
            const preflight = distributedRecipePreflight(recipe);
            errors.push(...preflight.errors.map((message) =>
                candidateError(
                    'preflight-validation',
                    tuningPreflightIssuePointer(basePath, message),
                    message
                )
            ));
        }
        catch (error) {
            errors.push(candidateError('preflight-validation', basePath, errorMessage(error)));
        }
    });
    return errors;
}

function applyPatch(
    manifest: RallarBlackBoxDistributedRunManifest,
    patch: readonly DistributedRunTuningPatchOperation[]
): void {
    for (const operation of patch) {
        const tokens = tuningPointerTokens(operation.path);
        const key = tokens.pop();
        if (key === undefined) {
            throw new Error(`Invalid patch path ${operation.path}.`);
        }
        let parent: unknown = manifest;
        for (const token of tokens) {
            parent = Array.isArray(parent)
                ? parent[Number(token)]
                : record(parent)[token];
        }
        const target = record(parent);
        if (operation.op === 'replace' && !Object.prototype.hasOwnProperty.call(target, key)) {
            throw new Error(`Replace target ${operation.path} does not exist.`);
        }
        target[key] = structuredClone(operation.value);
    }
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Patch path parent is not an object.');
    }
    return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function candidateError(
    code: DistributedRunTuningCandidateErrorCode,
    path: string | undefined,
    message: string
): DistributedRunTuningCandidateError {
    return { code, path, message };
}

function displayValue(value: number | undefined): string {
    return value === undefined ? '(unset)' : String(value);
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

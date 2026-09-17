import { Either } from '@shared/resilience/Either.ts';
import {
    RALLAR_BLACK_BOX_COMPOSITE_RESULT_PATH_VERSION,
    RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH
} from './composite-result-paths.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    RALLAR_BLACK_BOX_TEST_RESULT_STATUSES,
    type RallarBlackBoxTestCompositeChildResult,
    type RallarBlackBoxTestError,
    type RallarBlackBoxTestLoopChildResult,
    type RallarBlackBoxTestParallelChildResult,
    type RallarBlackBoxTestRedactionOptions,
    type RallarBlackBoxTestResult,
    type RallarBlackBoxTestResultStatus
} from './rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from './redaction.ts';
import { isJsonRecordValue } from './schema/json-schema-validation.ts';

export interface RallarBlackBoxCompositeChildPosition {
    readonly parentPath: string;
    readonly parentCommandId: string;
    readonly childIndex: number;
    readonly commandIndex: number;
    /** Absent when the recipe template names no command id. */
    readonly originalCommandId?: string;
}

export interface RallarBlackBoxCompositeLoopChildPosition extends RallarBlackBoxCompositeChildPosition {
    readonly kind: 'loop-child';
    readonly iteration: number;
}

export interface RallarBlackBoxCompositeParallelChildPosition extends RallarBlackBoxCompositeChildPosition {
    readonly kind: 'parallel-child';
    readonly groupId: string;
    readonly groupIndex: number;
}

/** A recorded part of a composite result value that does not decode, so the children it holds are not walked. */
export interface RallarBlackBoxCompositeChildDecodeIssue {
    /** The recorded object, such as `value.results[1]` or `value.groups[0]`. */
    readonly valuePath: string;
    /** Every field of that object that is missing or records an invalid value. */
    readonly invalidFields: readonly string[];
}

export type RallarBlackBoxCompositeResultPosition =
    | Readonly<{ kind: 'root'; }>
    | RallarBlackBoxCompositeLoopChildPosition
    | RallarBlackBoxCompositeParallelChildPosition;

export interface RallarBlackBoxCompositeResultFlatEntry {
    readonly path: string;
    readonly sourceRecipePath: string;
    readonly depth: number;
    readonly position: RallarBlackBoxCompositeResultPosition;
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestResult['kind'];
    readonly status: RallarBlackBoxTestResultStatus;
    readonly ok: boolean;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly durationMs: number;
    readonly childDecodeIssues: readonly RallarBlackBoxCompositeChildDecodeIssue[];
    readonly result: RallarBlackBoxTestResult;
}

export interface RallarBlackBoxCompositeResultTreeNode {
    readonly entry: RallarBlackBoxCompositeResultFlatEntry;
    readonly children: readonly RallarBlackBoxCompositeResultTreeNode[];
}

export interface RallarBlackBoxCompositeResultFirstFailure {
    readonly path: string;
    readonly sourceRecipePath: string;
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestResult['kind'];
    readonly status: RallarBlackBoxTestResultStatus;
    /** Absent when the failed result carries no error. */
    readonly message?: string;
}

export interface RallarBlackBoxCompositeResultSummary {
    readonly pathVersion: typeof RALLAR_BLACK_BOX_COMPOSITE_RESULT_PATH_VERSION;
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly skipped: number;
    readonly composite: number;
    readonly leaf: number;
    readonly childDecodeIssueCount: number;
    /** Absent when no entry failed. */
    readonly firstFailure?: RallarBlackBoxCompositeResultFirstFailure;
}

export interface RallarBlackBoxCompositeDisplayResult {
    readonly path: string;
    readonly sourceRecipePath: string;
    readonly depth: number;
    readonly position: RallarBlackBoxCompositeResultPosition;
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestResult['kind'];
    readonly status: RallarBlackBoxTestResultStatus;
    readonly ok: boolean;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly durationMs: number;
    /** The redacted result value; absent when the result carries none. */
    readonly value?: unknown;
    /** The redacted result error; absent when the result carries none. */
    readonly error?: RallarBlackBoxTestError;
}

interface EntryPlacement {
    readonly path: string;
    readonly sourceRecipePath: string;
    readonly depth: number;
    readonly position: RallarBlackBoxCompositeResultPosition;
}

interface PlacedChild {
    readonly result: RallarBlackBoxTestResult;
    readonly placement: EntryPlacement;
}

type ChildDecoding<Child> = Either<RallarBlackBoxCompositeChildDecodeIssue, Child>;

const RESULT_FIELD_GUARDS = {
    commandId: isText,
    kind: isCommandKind,
    status: isResultStatus,
    ok: isBoolean,
    startedAtEpochMs: isFiniteNumber,
    endedAtEpochMs: isFiniteNumber,
    durationMs: isFiniteNumber,
    error: isOptionalTestError,
    replayed: isOptionalBoolean
};

const COMPOSITE_CHILD_FIELD_GUARDS = {
    commandId: isText,
    originalCommandId: isOptionalText,
    parentCommandId: isText,
    path: isNonEmptyText,
    sourceRecipePath: isNonEmptyText,
    childIndex: isIndex,
    commandIndex: isIndex,
    result: isRallarBlackBoxTestResult
};

const LOOP_CHILD_FIELD_GUARDS = { ...COMPOSITE_CHILD_FIELD_GUARDS, iteration: isIndex };

const PARALLEL_CHILD_FIELD_GUARDS = { ...COMPOSITE_CHILD_FIELD_GUARDS, groupId: isText, groupIndex: isIndex };

export function toRallarBlackBoxCompositeResultFlatEntries(
    roots: readonly RallarBlackBoxTestResult[]
): readonly RallarBlackBoxCompositeResultFlatEntry[] {
    return roots.flatMap((result, index) => {
        const rootPath = roots.length === 1
            ? RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH
            : `${RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH}.results[${index}]`;
        return toFlatEntries(result, {
            path: rootPath,
            sourceRecipePath: rootPath,
            depth: 0,
            position: { kind: 'root' }
        });
    });
}

export function toRallarBlackBoxCompositeResultTimeline(
    roots: readonly RallarBlackBoxTestResult[]
): readonly RallarBlackBoxCompositeResultFlatEntry[] {
    return [...toRallarBlackBoxCompositeResultFlatEntries(roots)]
        .sort((left, right) =>
            left.startedAtEpochMs - right.startedAtEpochMs ||
            left.endedAtEpochMs - right.endedAtEpochMs ||
            left.path.localeCompare(right.path)
        );
}

export function toRallarBlackBoxCompositeResultTree(
    roots: readonly RallarBlackBoxTestResult[]
): readonly RallarBlackBoxCompositeResultTreeNode[] {
    const entries = toRallarBlackBoxCompositeResultFlatEntries(roots);
    const childrenByParentPath = new Map<string, RallarBlackBoxCompositeResultFlatEntry[]>();
    for (const entry of entries) {
        if (entry.position.kind === 'root') {
            continue;
        }
        const siblings = childrenByParentPath.get(entry.position.parentPath);
        if (siblings) {
            siblings.push(entry);
        }
        else {
            childrenByParentPath.set(entry.position.parentPath, [entry]);
        }
    }
    const toNode = (entry: RallarBlackBoxCompositeResultFlatEntry): RallarBlackBoxCompositeResultTreeNode => ({
        entry,
        children: (childrenByParentPath.get(entry.path) ?? []).map(toNode)
    });
    return entries.filter((entry) => entry.position.kind === 'root').map(toNode);
}

export function computeRallarBlackBoxCompositeResultSummary(
    roots: readonly RallarBlackBoxTestResult[],
    redaction: RallarBlackBoxTestRedactionOptions
): RallarBlackBoxCompositeResultSummary {
    const entries = toRallarBlackBoxCompositeResultFlatEntries(roots);
    const firstFailure = resolveRallarBlackBoxCompositeFirstFailure(roots);
    return {
        pathVersion: RALLAR_BLACK_BOX_COMPOSITE_RESULT_PATH_VERSION,
        total: entries.length,
        passed: entries.filter((entry) => entry.status === 'ok').length,
        failed: entries.filter((entry) => entry.status === 'failed').length,
        cancelled: entries.filter((entry) => entry.status === 'cancelled').length,
        skipped: entries.filter((entry) => entry.status === 'skipped').length,
        composite: entries.filter((entry) => isCompositeResult(entry.result)).length,
        leaf: entries.filter((entry) => !isCompositeResult(entry.result)).length,
        childDecodeIssueCount: entries.reduce((count, entry) => count + entry.childDecodeIssues.length, 0),
        firstFailure: firstFailure
            ? {
                path: firstFailure.path,
                sourceRecipePath: firstFailure.sourceRecipePath,
                commandId: firstFailure.commandId,
                kind: firstFailure.kind,
                status: firstFailure.status,
                message: redactRallarBlackBoxValue(firstFailure.result.error, redaction)?.message
            }
            : undefined
    };
}

/** A failed child outranks the composite parent it failed. */
export function resolveRallarBlackBoxCompositeFirstFailure(
    roots: readonly RallarBlackBoxTestResult[]
): RallarBlackBoxCompositeResultFlatEntry | undefined {
    const timeline = toRallarBlackBoxCompositeResultTimeline(roots);
    return timeline.find((entry) => !entry.ok && entry.depth > 0) ??
        timeline.find((entry) => !entry.ok);
}

export function toRallarBlackBoxCompositeDisplayResults(
    roots: readonly RallarBlackBoxTestResult[],
    redaction: RallarBlackBoxTestRedactionOptions
): readonly RallarBlackBoxCompositeDisplayResult[] {
    return toRallarBlackBoxCompositeResultFlatEntries(roots).map((entry) => ({
        path: entry.path,
        sourceRecipePath: entry.sourceRecipePath,
        depth: entry.depth,
        position: entry.position,
        commandId: entry.commandId,
        kind: entry.kind,
        status: entry.status,
        ok: entry.ok,
        startedAtEpochMs: entry.startedAtEpochMs,
        endedAtEpochMs: entry.endedAtEpochMs,
        durationMs: entry.durationMs,
        value: redactRallarBlackBoxValue(entry.result.value, redaction),
        error: redactRallarBlackBoxValue(entry.result.error, redaction)
    }));
}

function toFlatEntries(
    result: RallarBlackBoxTestResult,
    placement: EntryPlacement
): readonly RallarBlackBoxCompositeResultFlatEntry[] {
    const childDecodings = toChildDecodings(result, placement);
    const entry: RallarBlackBoxCompositeResultFlatEntry = {
        ...placement,
        commandId: result.commandId,
        kind: result.kind,
        status: result.status,
        ok: result.ok,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs: result.endedAtEpochMs,
        durationMs: result.durationMs,
        childDecodeIssues: childDecodings.flatMap((decoding) => decoding.fold((issue) => [issue], () => [])),
        result
    };
    return [
        entry,
        ...childDecodings.flatMap((decoding) =>
            decoding.fold(() => [], (child) => toFlatEntries(child.result, child.placement))
        )
    ];
}

function toChildDecodings(
    parent: RallarBlackBoxTestResult,
    placement: EntryPlacement
): readonly ChildDecoding<PlacedChild>[] {
    if (parent.kind === 'loop') {
        return decodeLoopChildResults(parent.value).map((decoding) =>
            decoding.mapRight((child) =>
                toPlacedChild(placement, child, {
                    kind: 'loop-child',
                    ...toChildPosition(placement, child),
                    iteration: child.iteration
                })
            )
        );
    }
    if (parent.kind === 'parallel') {
        return decodeParallelChildResults(parent.value).map((decoding) =>
            decoding.mapRight((child) =>
                toPlacedChild(placement, child, {
                    kind: 'parallel-child',
                    ...toChildPosition(placement, child),
                    groupId: child.groupId,
                    groupIndex: child.groupIndex
                })
            )
        );
    }
    return [];
}

function toChildPosition(
    parent: EntryPlacement,
    child: RallarBlackBoxTestCompositeChildResult
): RallarBlackBoxCompositeChildPosition {
    return {
        parentPath: parent.path,
        parentCommandId: child.parentCommandId,
        childIndex: child.childIndex,
        commandIndex: child.commandIndex,
        ...(child.originalCommandId === undefined ? {} : { originalCommandId: child.originalCommandId })
    };
}

function toPlacedChild(
    parent: EntryPlacement,
    child: RallarBlackBoxTestCompositeChildResult,
    position: RallarBlackBoxCompositeResultPosition
): PlacedChild {
    return {
        result: child.result,
        placement: {
            path: toNestedResultPath(parent.path, child.path),
            sourceRecipePath: toNestedResultPath(parent.sourceRecipePath, child.sourceRecipePath),
            depth: parent.depth + 1,
            position
        }
    };
}

/** A path relative to the composite root is rebased under the parent path; any other path is kept. */
function toNestedResultPath(parentPath: string, childPath: string): string {
    if (childPath === RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH) {
        return parentPath;
    }
    return childPath.startsWith(`${RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH}.`)
        ? `${parentPath}${childPath.slice(RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH.length)}`
        : childPath;
}

function isCompositeResult(result: RallarBlackBoxTestResult): boolean {
    return result.kind === 'loop' || result.kind === 'parallel';
}

/**
 * A loop without a recorded value, or whose value the control server compacted with `resultsOmitted`, holds no
 * children; a recorded value without its child list is one issue.
 */
function decodeLoopChildResults(value: unknown): readonly ChildDecoding<RallarBlackBoxTestLoopChildResult>[] {
    if (value === undefined || (isJsonRecordValue(value) && value.resultsOmitted === true)) {
        return [];
    }
    if (!isJsonRecordValue(value) || !Array.isArray(value.results)) {
        return [Either.ofLeft({ valuePath: 'value', invalidFields: ['results'] })];
    }
    return value.results.map((child, index) => decodeLoopChildResult(child, `value.results[${index}]`));
}

/** A composite without a recorded value holds no children; a value or group without its child list is one issue. */
function decodeParallelChildResults(value: unknown): readonly ChildDecoding<RallarBlackBoxTestParallelChildResult>[] {
    if (value === undefined) {
        return [];
    }
    if (!isJsonRecordValue(value) || !Array.isArray(value.groups)) {
        return [Either.ofLeft({ valuePath: 'value', invalidFields: ['groups'] })];
    }
    return value.groups.flatMap((group, groupIndex) =>
        decodeParallelGroupChildResults(group, `value.groups[${groupIndex}]`)
    );
}

function decodeParallelGroupChildResults(
    group: unknown,
    valuePath: string
): readonly ChildDecoding<RallarBlackBoxTestParallelChildResult>[] {
    if (!isJsonRecordValue(group) || !Array.isArray(group.results)) {
        return [Either.ofLeft({ valuePath, invalidFields: ['results'] })];
    }
    return group.results.map((child, index) => decodeParallelChildResult(child, `${valuePath}.results[${index}]`));
}

/** A recorded child that is not a JSON object lacks every required field. */
function decodeLoopChildResult(value: unknown, valuePath: string): ChildDecoding<RallarBlackBoxTestLoopChildResult> {
    const child = isJsonRecordValue(value) ? value : {};
    const invalidFields = Object.entries(LOOP_CHILD_FIELD_GUARDS)
        .filter(([field, isValidField]) => !isValidField(child[field]))
        .map(([field]) => field);
    return invalidFields.length === 0
        ? Either.ofRight(value as RallarBlackBoxTestLoopChildResult)
        : Either.ofLeft({ valuePath, invalidFields });
}

/** A recorded child that is not a JSON object lacks every required field. */
function decodeParallelChildResult(
    value: unknown,
    valuePath: string
): ChildDecoding<RallarBlackBoxTestParallelChildResult> {
    const child = isJsonRecordValue(value) ? value : {};
    const invalidFields = Object.entries(PARALLEL_CHILD_FIELD_GUARDS)
        .filter(([field, isValidField]) => !isValidField(child[field]))
        .map(([field]) => field);
    return invalidFields.length === 0
        ? Either.ofRight(value as RallarBlackBoxTestParallelChildResult)
        : Either.ofLeft({ valuePath, invalidFields });
}

export function isRallarBlackBoxTestResult(value: unknown): value is RallarBlackBoxTestResult {
    return decodeRallarBlackBoxTestResult(value).right !== undefined;
}

/** The left names every field that is missing or records an invalid value; a value that is not a JSON object lacks them all. */
export function decodeRallarBlackBoxTestResult(value: unknown): Either<readonly string[], RallarBlackBoxTestResult> {
    const result = isJsonRecordValue(value) ? value : {};
    const invalidFields = Object.entries(RESULT_FIELD_GUARDS)
        .filter(([field, isValidField]) => !isValidField(result[field]))
        .map(([field]) => field);
    return invalidFields.length === 0
        ? Either.ofRight(value as RallarBlackBoxTestResult)
        : Either.ofLeft(invalidFields);
}

function isRallarBlackBoxTestError(value: unknown): value is RallarBlackBoxTestError {
    return isJsonRecordValue(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

function isOptionalTestError(value: unknown): value is RallarBlackBoxTestError | undefined {
    return value === undefined || isRallarBlackBoxTestError(value);
}

function isCommandKind(value: unknown): value is RallarBlackBoxTestResult['kind'] {
    return typeof value === 'string' && RALLAR_BLACK_BOX_TEST_COMMAND_KINDS.some((kind) => kind === value);
}

function isResultStatus(value: unknown): value is RallarBlackBoxTestResultStatus {
    return typeof value === 'string' && RALLAR_BLACK_BOX_TEST_RESULT_STATUSES.some((status) => status === value);
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isText(value: unknown): value is string {
    return typeof value === 'string';
}

function isOptionalText(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isNonEmptyText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isIndex(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

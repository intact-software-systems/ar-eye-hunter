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

interface ParallelGroupChildResults {
    readonly results: readonly RallarBlackBoxTestParallelChildResult[];
}

interface ChildPlacement {
    readonly child: RallarBlackBoxTestCompositeChildResult;
    readonly placement: EntryPlacement;
}

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
    const entry: RallarBlackBoxCompositeResultFlatEntry = {
        ...placement,
        commandId: result.commandId,
        kind: result.kind,
        status: result.status,
        ok: result.ok,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs: result.endedAtEpochMs,
        durationMs: result.durationMs,
        result
    };
    return [
        entry,
        ...toChildPlacements(entry).flatMap((child) => toFlatEntries(child.child.result, child.placement))
    ];
}

function toChildPlacements(parent: RallarBlackBoxCompositeResultFlatEntry): readonly ChildPlacement[] {
    if (parent.kind === 'loop') {
        return decodeLoopChildResults(parent.result.value).map((child) => ({
            child,
            placement: toChildPlacement(parent, child, {
                kind: 'loop-child',
                ...toChildPosition(parent, child),
                iteration: child.iteration
            })
        }));
    }
    if (parent.kind === 'parallel') {
        return decodeParallelChildResults(parent.result.value).map((child) => ({
            child,
            placement: toChildPlacement(parent, child, {
                kind: 'parallel-child',
                ...toChildPosition(parent, child),
                groupId: child.groupId,
                groupIndex: child.groupIndex
            })
        }));
    }
    return [];
}

function toChildPosition(
    parent: RallarBlackBoxCompositeResultFlatEntry,
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

function toChildPlacement(
    parent: RallarBlackBoxCompositeResultFlatEntry,
    child: RallarBlackBoxTestCompositeChildResult,
    position: RallarBlackBoxCompositeResultPosition
): EntryPlacement {
    return {
        path: toNestedResultPath(parent.path, child.path),
        sourceRecipePath: toNestedResultPath(parent.sourceRecipePath, child.sourceRecipePath),
        depth: parent.depth + 1,
        position
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

/** A loop value whose children do not all decode contributes no child entries. */
function decodeLoopChildResults(value: unknown): readonly RallarBlackBoxTestLoopChildResult[] {
    if (!isJsonRecordValue(value) || !Array.isArray(value.results) || !value.results.every(isLoopChildResult)) {
        return [];
    }
    return value.results;
}

/** A parallel value whose groups or children do not all decode contributes no child entries. */
function decodeParallelChildResults(value: unknown): readonly RallarBlackBoxTestParallelChildResult[] {
    if (!isJsonRecordValue(value) || !Array.isArray(value.groups) || !value.groups.every(isParallelGroupChildResults)) {
        return [];
    }
    return value.groups.flatMap((group) => group.results);
}

function isParallelGroupChildResults(value: unknown): value is ParallelGroupChildResults {
    return isJsonRecordValue(value) && Array.isArray(value.results) && value.results.every(isParallelChildResult);
}

function isLoopChildResult(value: unknown): value is RallarBlackBoxTestLoopChildResult {
    return isCompositeChildResult(value) && 'iteration' in value && isIndex(value.iteration);
}

function isParallelChildResult(value: unknown): value is RallarBlackBoxTestParallelChildResult {
    return isCompositeChildResult(value) &&
        'groupId' in value &&
        typeof value.groupId === 'string' &&
        'groupIndex' in value &&
        isIndex(value.groupIndex);
}

function isCompositeChildResult(value: unknown): value is RallarBlackBoxTestCompositeChildResult {
    return isJsonRecordValue(value) &&
        typeof value.commandId === 'string' &&
        (value.originalCommandId === undefined || typeof value.originalCommandId === 'string') &&
        typeof value.parentCommandId === 'string' &&
        isNonEmptyText(value.path) &&
        isNonEmptyText(value.sourceRecipePath) &&
        isIndex(value.childIndex) &&
        isIndex(value.commandIndex) &&
        isRallarBlackBoxTestResult(value.result);
}

function isRallarBlackBoxTestResult(value: unknown): value is RallarBlackBoxTestResult {
    return isJsonRecordValue(value) &&
        typeof value.commandId === 'string' &&
        RALLAR_BLACK_BOX_TEST_COMMAND_KINDS.some((kind) => kind === value.kind) &&
        RALLAR_BLACK_BOX_TEST_RESULT_STATUSES.some((status) => status === value.status) &&
        typeof value.ok === 'boolean' &&
        Number.isFinite(value.startedAtEpochMs) &&
        Number.isFinite(value.endedAtEpochMs) &&
        Number.isFinite(value.durationMs) &&
        (value.error === undefined || isRallarBlackBoxTestError(value.error)) &&
        (value.replayed === undefined || typeof value.replayed === 'boolean');
}

function isRallarBlackBoxTestError(value: unknown): value is RallarBlackBoxTestError {
    return isJsonRecordValue(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

function isNonEmptyText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isIndex(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

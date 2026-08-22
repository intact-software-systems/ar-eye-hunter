import { redactRallarBlackBoxValue } from './redaction.ts';
import type {
    RallarBlackBoxTestCompositeChildResult,
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestParallelGroupResult,
    RallarBlackBoxTestParallelResultValue,
    RallarBlackBoxTestRedactionOptions,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestResultStatus
} from './types.ts';

export const RALLAR_BLACK_BOX_COMPOSITE_RESULT_PATH_VERSION = 1;
export const RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH = '$';

export type RallarBlackBoxCompositeResultFlatEntry = Readonly<{
    path: string;
    sourceRecipePath: string;
    parentPath?: string;
    parentCommandId?: string;
    depth: number;
    childIndex?: number;
    commandIndex?: number;
    iteration?: number;
    groupId?: string;
    groupIndex?: number;
    originalCommandId?: string;
    commandId: string;
    kind: RallarBlackBoxTestResult['kind'];
    status: RallarBlackBoxTestResultStatus;
    ok: boolean;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    durationMs: number;
    result: RallarBlackBoxTestResult;
}>;

export type RallarBlackBoxCompositeResultTreeNode = Readonly<{
    entry: RallarBlackBoxCompositeResultFlatEntry;
    children: readonly RallarBlackBoxCompositeResultTreeNode[];
}>;

export type RallarBlackBoxCompositeResultSummary = Readonly<{
    pathVersion: typeof RALLAR_BLACK_BOX_COMPOSITE_RESULT_PATH_VERSION;
    total: number;
    passed: number;
    failed: number;
    cancelled: number;
    skipped: number;
    composite: number;
    leaf: number;
    firstFailure?: Readonly<{
        path: string;
        sourceRecipePath: string;
        commandId: string;
        kind: RallarBlackBoxTestResult['kind'];
        status: RallarBlackBoxTestResultStatus;
        message?: string;
    }>;
}>;

export type RallarBlackBoxCompositeDisplayResult = Readonly<{
    path: string;
    sourceRecipePath: string;
    parentPath?: string;
    parentCommandId?: string;
    depth: number;
    childIndex?: number;
    commandIndex?: number;
    iteration?: number;
    groupId?: string;
    groupIndex?: number;
    originalCommandId?: string;
    commandId: string;
    kind: RallarBlackBoxTestResult['kind'];
    status: RallarBlackBoxTestResultStatus;
    ok: boolean;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    durationMs: number;
    value?: unknown;
    error?: unknown;
}>;

type FlattenOptions = Readonly<{
    includeRoot?: boolean;
}>;

type WalkContext = Readonly<{
    path: string;
    sourceRecipePath: string;
    commandId?: string;
    parentPath?: string;
    parentCommandId?: string;
    depth: number;
    childIndex?: number;
    commandIndex?: number;
    iteration?: number;
    groupId?: string;
    groupIndex?: number;
    originalCommandId?: string;
}>;

export function rallarBlackBoxLoopChildResultPath(
    parentPath: string,
    iteration: number,
    commandIndex: number
): string {
    return `${parentPath}.iterations[${iteration}].commands[${commandIndex}]`;
}

export function rallarBlackBoxLoopChildSourceRecipePath(
    parentSourceRecipePath: string,
    commandIndex: number
): string {
    return `${parentSourceRecipePath}.commands[${commandIndex}]`;
}

export function rallarBlackBoxParallelChildResultPath(
    parentPath: string,
    groupIndex: number,
    groupId: string,
    commandIndex: number
): string {
    return `${parentPath}.groups[${groupIndex}=${encodeURIComponent(groupId)}].commands[${commandIndex}]`;
}

export function rallarBlackBoxParallelChildSourceRecipePath(
    parentSourceRecipePath: string,
    groupIndex: number,
    commandIndex: number
): string {
    return `${parentSourceRecipePath}.groups[${groupIndex}].commands[${commandIndex}]`;
}

export function flattenRallarBlackBoxCompositeResults(
    input: RallarBlackBoxTestResult | readonly RallarBlackBoxTestResult[],
    options: FlattenOptions = {}
): readonly RallarBlackBoxCompositeResultFlatEntry[] {
    const includeRoot = options.includeRoot !== false;
    const roots = Array.isArray(input) ? input : [input];
    const entries: RallarBlackBoxCompositeResultFlatEntry[] = [];

    roots.forEach((result, index) => {
        const rootPath = roots.length === 1
            ? RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH
            : `${RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH}.results[${index}]`;
        walkResult(
            result,
            {
                path: rootPath,
                sourceRecipePath: rootPath,
                commandId: result.commandId,
                depth: 0
            },
            includeRoot,
            entries
        );
    });

    return entries;
}

export function toRallarBlackBoxCompositeResultTimeline(
    input: RallarBlackBoxTestResult | readonly RallarBlackBoxTestResult[],
    options: FlattenOptions = {}
): readonly RallarBlackBoxCompositeResultFlatEntry[] {
    return [...flattenRallarBlackBoxCompositeResults(input, options)]
        .sort((left, right) =>
            left.startedAtEpochMs - right.startedAtEpochMs ||
            left.endedAtEpochMs - right.endedAtEpochMs ||
            left.path.localeCompare(right.path)
        );
}

export function toRallarBlackBoxCompositeResultTree(
    input: RallarBlackBoxTestResult | readonly RallarBlackBoxTestResult[],
    options: FlattenOptions = {}
): readonly RallarBlackBoxCompositeResultTreeNode[] {
    const entries = flattenRallarBlackBoxCompositeResults(input, options);
    const byPath = new Map<string, RallarBlackBoxCompositeResultTreeNode>();
    const roots: RallarBlackBoxCompositeResultTreeNode[] = [];

    for (const entry of entries) {
        byPath.set(entry.path, {
            entry,
            children: []
        });
    }

    for (const entry of entries) {
        const node = byPath.get(entry.path);
        if (!node) {
            continue;
        }

        const parent = entry.parentPath ? byPath.get(entry.parentPath) : undefined;
        if (parent) {
            (parent.children as RallarBlackBoxCompositeResultTreeNode[]).push(node);
        }
        else {
            roots.push(node);
        }
    }

    return roots;
}

export function summarizeRallarBlackBoxCompositeResults(
    input: RallarBlackBoxTestResult | readonly RallarBlackBoxTestResult[],
    options: FlattenOptions & Readonly<{ redaction?: RallarBlackBoxTestRedactionOptions; }> = {}
): RallarBlackBoxCompositeResultSummary {
    const entries = flattenRallarBlackBoxCompositeResults(input, options);
    const firstFailure = findFirstFailedRallarBlackBoxCompositeResult(input, options);
    const firstFailureError = firstFailure
        ? redactRallarBlackBoxValue(firstFailure.result.error, options.redaction)
        : undefined;

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
                message: firstFailureError?.message
            }
            : undefined
    };
}

export function findFirstFailedRallarBlackBoxCompositeResult(
    input: RallarBlackBoxTestResult | readonly RallarBlackBoxTestResult[],
    options: FlattenOptions = {}
): RallarBlackBoxCompositeResultFlatEntry | undefined {
    const timeline = toRallarBlackBoxCompositeResultTimeline(input, options);
    return timeline.find((entry) => !entry.ok && entry.depth > 0) ??
        timeline.find((entry) => !entry.ok);
}

export function toRallarBlackBoxCompositeDisplayResults(
    input: RallarBlackBoxTestResult | readonly RallarBlackBoxTestResult[],
    options: FlattenOptions & Readonly<{ redaction?: RallarBlackBoxTestRedactionOptions; }> = {}
): readonly RallarBlackBoxCompositeDisplayResult[] {
    return flattenRallarBlackBoxCompositeResults(input, options)
        .map((entry) => ({
            path: entry.path,
            sourceRecipePath: entry.sourceRecipePath,
            parentPath: entry.parentPath,
            parentCommandId: entry.parentCommandId,
            depth: entry.depth,
            childIndex: entry.childIndex,
            commandIndex: entry.commandIndex,
            iteration: entry.iteration,
            groupId: entry.groupId,
            groupIndex: entry.groupIndex,
            originalCommandId: entry.originalCommandId,
            commandId: entry.commandId,
            kind: entry.kind,
            status: entry.status,
            ok: entry.ok,
            startedAtEpochMs: entry.startedAtEpochMs,
            endedAtEpochMs: entry.endedAtEpochMs,
            durationMs: entry.durationMs,
            value: redactRallarBlackBoxValue(entry.result.value, options.redaction),
            error: redactRallarBlackBoxValue(entry.result.error, options.redaction)
        }));
}

function walkResult(
    result: RallarBlackBoxTestResult,
    context: WalkContext,
    includeCurrent: boolean,
    entries: RallarBlackBoxCompositeResultFlatEntry[]
): void {
    if (includeCurrent) {
        entries.push({
            path: context.path,
            sourceRecipePath: context.sourceRecipePath,
            parentPath: context.parentPath,
            parentCommandId: context.parentCommandId,
            depth: context.depth,
            childIndex: context.childIndex,
            commandIndex: context.commandIndex,
            iteration: context.iteration,
            groupId: context.groupId,
            groupIndex: context.groupIndex,
            originalCommandId: context.originalCommandId,
            commandId: result.commandId,
            kind: result.kind,
            status: result.status,
            ok: result.ok,
            startedAtEpochMs: result.startedAtEpochMs,
            endedAtEpochMs: result.endedAtEpochMs,
            durationMs: result.durationMs,
            result
        });
    }

    if (result.kind === 'loop') {
        const value = loopResultValue(result.value);
        value?.results.forEach((child, childIndex) => {
            walkResult(child.result, loopChildContext(child, childIndex, context), true, entries);
        });
        return;
    }

    if (result.kind === 'parallel') {
        const value = parallelResultValue(result.value);
        value?.groups.forEach((group, groupIndex) => {
            group.results.forEach((child, childIndex) => {
                walkResult(
                    child.result,
                    parallelChildContext(child, childIndex, group, groupIndex, context),
                    true,
                    entries
                );
            });
        });
    }
}

function loopChildContext(
    child: RallarBlackBoxTestCompositeChildResult,
    childIndex: number,
    parent: WalkContext
): WalkContext {
    const iteration = child.iteration ?? 0;
    const commandIndex = child.commandIndex;
    return {
        path: composeChildPath(
            parent.path,
            child.path,
            rallarBlackBoxLoopChildResultPath(parent.path, iteration, commandIndex)
        ),
        sourceRecipePath: composeChildPath(
            parent.sourceRecipePath,
            child.sourceRecipePath,
            rallarBlackBoxLoopChildSourceRecipePath(parent.sourceRecipePath, commandIndex)
        ),
        parentPath: parent.path,
        parentCommandId: child.parentCommandId ?? parent.commandId,
        commandId: child.result.commandId,
        depth: parent.depth + 1,
        childIndex: child.childIndex ?? childIndex,
        commandIndex,
        iteration,
        originalCommandId: child.originalCommandId
    };
}

function parallelChildContext(
    child: RallarBlackBoxTestCompositeChildResult,
    childIndex: number,
    group: RallarBlackBoxTestParallelGroupResult,
    groupIndex: number,
    parent: WalkContext
): WalkContext {
    const commandIndex = child.commandIndex;
    const groupId = child.groupId ?? group.groupId;
    return {
        path: composeChildPath(
            parent.path,
            child.path,
            rallarBlackBoxParallelChildResultPath(parent.path, groupIndex, groupId, commandIndex)
        ),
        sourceRecipePath: composeChildPath(
            parent.sourceRecipePath,
            child.sourceRecipePath,
            rallarBlackBoxParallelChildSourceRecipePath(parent.sourceRecipePath, groupIndex, commandIndex)
        ),
        parentPath: parent.path,
        parentCommandId: child.parentCommandId ?? parent.commandId,
        commandId: child.result.commandId,
        depth: parent.depth + 1,
        childIndex: child.childIndex ?? childIndex,
        commandIndex,
        groupId,
        groupIndex: child.groupIndex ?? groupIndex,
        originalCommandId: child.originalCommandId
    };
}

function composeChildPath(parentPath: string, childPath: string | undefined, fallback: string): string {
    if (!childPath) {
        return fallback;
    }
    if (childPath === RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH) {
        return parentPath;
    }
    if (childPath.startsWith(`${RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH}.`)) {
        return `${parentPath}${childPath.slice(RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH.length)}`;
    }
    return childPath;
}

function loopResultValue(value: unknown): RallarBlackBoxTestLoopResultValue | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as Partial<RallarBlackBoxTestLoopResultValue>;
    return Array.isArray(candidate.results) ? candidate as RallarBlackBoxTestLoopResultValue : undefined;
}

function parallelResultValue(value: unknown): RallarBlackBoxTestParallelResultValue | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as Partial<RallarBlackBoxTestParallelResultValue>;
    return Array.isArray(candidate.groups) ? candidate as RallarBlackBoxTestParallelResultValue : undefined;
}

function isCompositeResult(result: RallarBlackBoxTestResult): boolean {
    return result.kind === 'loop' || result.kind === 'parallel';
}

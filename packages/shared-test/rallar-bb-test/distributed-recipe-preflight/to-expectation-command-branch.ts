import type {
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestWaitCommand
} from '../rallar-black-box-test-contracts.ts';
import {
    DEFAULT_WAIT_TIMEOUT_MS,
    type DistributedRecipeCommandBranch,
    type DistributedRecipePreflightAssert,
    type DistributedRecipePreflightWait
} from './distributed-recipe-preflight-contracts.ts';

export function toWaitCommandBranch(
    command: RallarBlackBoxTestWaitCommand,
    path: string
): DistributedRecipeCommandBranch {
    const wait: DistributedRecipePreflightWait = {
        path,
        commandId: command.commandId,
        matchSummary: toMatchSummary(command.match),
        timeoutMs: command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    };
    return {
        effectiveCommandCount: 1,
        childAnalyses: [],
        summary: `wait up to ${command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS} ms`,
        details: [wait.matchSummary],
        warnings: [`${path}: wait can time out if matching evidence is not emitted.`],
        errors: [],
        loops: [],
        parallelGroups: [],
        waits: [wait],
        asserts: []
    };
}

export function toAssertCommandBranch(
    command: RallarBlackBoxTestAssertCommand,
    path: string
): DistributedRecipeCommandBranch {
    const assertion: DistributedRecipePreflightAssert = {
        path,
        commandId: command.commandId,
        predicate: `${command.source} ${command.operator}${
            command.expected === undefined ? '' : ` ${toShortValue(command.expected)}`
        }`
    };
    return {
        effectiveCommandCount: 1,
        childAnalyses: [],
        summary: assertion.predicate,
        details: [],
        warnings: [`${path}: assert fails the recipe when its runtime evidence does not match.`],
        errors: [],
        loops: [],
        parallelGroups: [],
        waits: [],
        asserts: [assertion]
    };
}

function toMatchSummary(match: RallarBlackBoxTestWaitCommand['match']): string {
    const entries = Object.entries(match).map(([key, value]) => `${key}=${toShortValue(value)}`);
    return entries.length > 0 ? entries.join(', ') : 'any runtime evidence';
}

function toShortValue(value: unknown): string {
    const rendered = typeof value === 'string'
        ? value
        : JSON.stringify(value);
    if (rendered === undefined) {
        return 'undefined';
    }
    return rendered.length > 72 ? `${rendered.slice(0, 69)}...` : rendered;
}

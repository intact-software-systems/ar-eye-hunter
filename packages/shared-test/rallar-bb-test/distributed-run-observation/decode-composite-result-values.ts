import type {
    RallarBlackBoxTestAssertResultValue,
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestParallelResultValue,
    RallarBlackBoxTestWaitResultValue
} from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';

export function decodeLoopResultValue(value: unknown): RallarBlackBoxTestLoopResultValue | undefined {
    const candidate = decodeRecord(value) as Partial<RallarBlackBoxTestLoopResultValue>;
    return Array.isArray(candidate.results) &&
            typeof candidate.iterations === 'number' &&
            typeof candidate.childResultCount === 'number'
        ? candidate as RallarBlackBoxTestLoopResultValue
        : undefined;
}

export function decodeParallelResultValue(value: unknown): RallarBlackBoxTestParallelResultValue | undefined {
    const candidate = decodeRecord(value) as Partial<RallarBlackBoxTestParallelResultValue>;
    return Array.isArray(candidate.groups) &&
            typeof candidate.groupCount === 'number' &&
            typeof candidate.maxConcurrency === 'number'
        ? candidate as RallarBlackBoxTestParallelResultValue
        : undefined;
}

export function decodeWaitResultValue(value: unknown): RallarBlackBoxTestWaitResultValue | undefined {
    const candidate = decodeRecord(value) as Partial<RallarBlackBoxTestWaitResultValue>;
    return typeof candidate.matched === 'boolean'
        ? candidate as RallarBlackBoxTestWaitResultValue
        : undefined;
}

export function decodeAssertResultValue(value: unknown): RallarBlackBoxTestAssertResultValue | undefined {
    const candidate = decodeRecord(value) as Partial<RallarBlackBoxTestAssertResultValue>;
    const common = typeof candidate.operator === 'string' &&
        typeof candidate.exists === 'boolean' &&
        typeof candidate.passed === 'boolean';
    if (!common) {
        return undefined;
    }
    if (candidate.operator === 'sameUniqueStringSet') {
        return typeof candidate.comparisonExists === 'boolean'
            ? candidate as RallarBlackBoxTestAssertResultValue
            : undefined;
    }
    return candidate as RallarBlackBoxTestAssertResultValue;
}

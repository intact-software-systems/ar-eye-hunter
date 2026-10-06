import { Either } from '../resilience/Either.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from './al-message-resource-limits.ts';
import type { ALSeqRange } from './al-runtime.ts';

/** The first sequences of a range list, and the ranges that cover exactly what the page left. */
export interface ALSeqRangePage {
    readonly page: readonly number[];
    readonly remaining: readonly ALSeqRange[];
}

/** The first `pageSize` sequences of sorted, disjoint ranges, ascending, and the ranges of the rest. */
export function computeALSeqRangePage(ranges: readonly ALSeqRange[], pageSize: number): ALSeqRangePage {
    const page: number[] = [];
    const remaining: ALSeqRange[] = [];
    for (const range of ranges) {
        if (page.length >= pageSize) {
            remaining.push(range);
            continue;
        }
        const pageEnd = Math.min(range.to, range.from + pageSize - page.length - 1);
        for (let seq = range.from; seq <= pageEnd; seq += 1) {
            page.push(seq);
        }
        if (pageEnd < range.to) {
            remaining.push({ from: pageEnd + 1, to: range.to });
        }
    }
    return { page, remaining };
}

/** Ranges joined as `from-to` with `,`, the bounded text an effect identity carries. */
export function toALSeqRangesText(ranges: readonly ALSeqRange[]): string {
    return ranges.map((range) => `${range.from}-${range.to}`).join(',');
}

/**
 * A wire or persisted range list: a dense plain array of at most `repairRanges` plain `{ from, to }`
 * records with safe non-negative integer bounds, `from <= to`, sorted and disjoint.
 */
export function decodeALSeqRanges(value: unknown): Either<TypeError, readonly ALSeqRange[]> {
    if (
        !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > AL_MESSAGE_RESOURCE_LIMITS.repairRanges ||
        Reflect.ownKeys(value).length !== value.length + 1
    ) {
        return Either.ofLeft(new TypeError('Sequence ranges must be a dense array within the range limit'));
    }
    const ranges: ALSeqRange[] = [];
    for (let index = 0; index < value.length; index++) {
        const range = toALSeqRange(Object.getOwnPropertyDescriptor(value, index));
        if (range === undefined) {
            return Either.ofLeft(new TypeError('Sequence range must be a plain {from, to} record with from <= to'));
        }
        const previous = ranges[ranges.length - 1];
        if (previous !== undefined && range.from <= previous.to) {
            return Either.ofLeft(new TypeError('Sequence ranges must be sorted and disjoint'));
        }
        ranges.push(range);
    }
    return Either.ofRight(ranges);
}

/** The range an enumerable data entry holds as a plain `{ from, to }` record, or nothing. */
function toALSeqRange(entry: PropertyDescriptor | undefined): ALSeqRange | undefined {
    if (!isDataProperty(entry) || !isPlainRecord(entry.value)) {
        return undefined;
    }
    const keys = Reflect.ownKeys(entry.value);
    if (keys.length !== 2 || !keys.includes('from') || !keys.includes('to')) {
        return undefined;
    }
    const from = Object.getOwnPropertyDescriptor(entry.value, 'from');
    const to = Object.getOwnPropertyDescriptor(entry.value, 'to');
    if (!isDataProperty(from) || !isDataProperty(to)) {
        return undefined;
    }
    return isALSeqBound(from.value) && isALSeqBound(to.value) && from.value <= to.value
        ? { from: from.value, to: to.value }
        : undefined;
}

function isDataProperty(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor {
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function isPlainRecord(value: unknown): value is object {
    return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isALSeqBound(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

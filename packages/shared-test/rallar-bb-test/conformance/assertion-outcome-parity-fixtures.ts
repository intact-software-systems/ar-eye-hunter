// deno-lint-ignore-file no-explicit-any
import type { JsonValue } from '../../json-compare/CompareJson.ts';

import type { RallarBlackBoxTestAssertOperator } from '../types.ts';
import type { AssertionOutcomeVerdict } from './assertion-outcome-parity.ts';

export interface ComparatorParityFixture {
    readonly fixtureId: string;
    readonly value: any;
    readonly runnerComparator: Readonly<Record<string, any>> & Readonly<{ path: string }>;
    readonly runtimeOperator: RallarBlackBoxTestAssertOperator;
    readonly runtimeExpected: any;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

export const COMPARATOR_FIXTURES: readonly ComparatorParityFixture[] = [
    {
        fixtureId: 'gt-string-number-passes',
        value: { score: '17' },
        runnerComparator: { path: 'score', gt: 16 },
        runtimeOperator: 'gt',
        runtimeExpected: 16,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'gt-equal-fails',
        value: { score: 17 },
        runnerComparator: { path: 'score', gt: 17 },
        runtimeOperator: 'gt',
        runtimeExpected: 17,
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'lt-passes',
        value: { score: 3 },
        runnerComparator: { path: 'score', lt: 4 },
        runtimeOperator: 'lt',
        runtimeExpected: 4,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'between-inclusive-bound-passes',
        value: { score: 20 },
        runnerComparator: { path: 'score', between: [17, 20] },
        runtimeOperator: 'between',
        runtimeExpected: [17, 20],
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'between-outside-fails',
        value: { score: 21 },
        runnerComparator: { path: 'score', between: [17, 20] },
        runtimeOperator: 'between',
        runtimeExpected: [17, 20],
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'between-malformed-pair-fails',
        value: { score: 18 },
        runnerComparator: { path: 'score', between: [17] },
        runtimeOperator: 'between',
        runtimeExpected: [17],
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'length-array-passes',
        value: { items: ['a', 'b', 'c'] },
        runnerComparator: { path: 'items', length: 3 },
        runtimeOperator: 'length',
        runtimeExpected: 3,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'length-non-collection-fails',
        value: { items: 42 },
        runnerComparator: { path: 'items', length: 2 },
        runtimeOperator: 'length',
        runtimeExpected: 2,
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'matches-pattern-passes',
        value: { marker: 'assert-operators' },
        runnerComparator: { path: 'marker', matches: '^assert-' },
        runtimeOperator: 'matches',
        runtimeExpected: '^assert-',
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'matches-non-string-fails',
        value: { marker: 42 },
        runnerComparator: { path: 'marker', matches: '^assert-' },
        runtimeOperator: 'matches',
        runtimeExpected: '^assert-',
        expectedVerdict: 'fail',
    },
];

export interface CompleteArrayParityFixture {
    readonly fixtureId: string;
    readonly expected: JsonValue;
    readonly actual: JsonValue;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

export const COMPLETE_ARRAY_FIXTURES: readonly CompleteArrayParityFixture[] = [
    {
        fixtureId: 'complete-exact-array-passes',
        expected: { items: ['expected-item'] },
        actual: { items: ['expected-item'] },
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'complete-unexpected-element-fails',
        expected: { items: ['expected-item'] },
        actual: { items: ['expected-item', 'unexpected-item'] },
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'complete-extra-object-key-passes',
        expected: { items: ['expected-item'] },
        actual: { items: ['expected-item'], extra: 'allowed' },
        expectedVerdict: 'pass',
    },
];

export interface AbsenceParityFixture {
    readonly fixtureId: string;
    readonly bufferedTopics: readonly string[];
    readonly forbiddenTopic: string;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

export const ABSENCE_FIXTURES: readonly AbsenceParityFixture[] = [
    {
        fixtureId: 'absence-holds-on-clean-buffer',
        bufferedTopics: ['room.allowed.control'],
        forbiddenTopic: 'room.forbidden.leak',
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'absence-violated-by-buffered-event',
        bufferedTopics: ['room.allowed.control', 'room.forbidden.leak'],
        forbiddenTopic: 'room.forbidden.leak',
        expectedVerdict: 'fail',
    },
];

export interface PollingParityFixture {
    readonly fixtureId: string;
    readonly succeedOnAttempt: number | undefined;
    readonly maxAttempts: number;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

export const POLLING_FIXTURES: readonly PollingParityFixture[] = [
    {
        fixtureId: 'polling-converges-before-bounds',
        succeedOnAttempt: 3,
        maxAttempts: 5,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'polling-exhausts-bounds',
        succeedOnAttempt: undefined,
        maxAttempts: 3,
        expectedVerdict: 'fail',
    },
];

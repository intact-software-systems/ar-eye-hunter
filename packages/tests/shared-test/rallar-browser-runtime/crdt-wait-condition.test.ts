import type { BlackBoxRallarCrdtWaitCondition } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { matchesBlackBoxRallarCrdtWaitCondition } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/matches-black-box-rallar-crdt-wait-condition.ts';
import type { RallarCrdtJsonValue } from '@shared/crdt/mod.ts';
import {
    expect,
    it
} from 'vitest';

interface WaitConditionCase {
    readonly name: string;
    readonly value: RallarCrdtJsonValue;
    readonly condition: BlackBoxRallarCrdtWaitCondition;
    readonly matched: boolean;
}

const cases: readonly WaitConditionCase[] = [
    {
        name: 'nested array value',
        value: { items: [{ done: true }] },
        condition: { source: 'value', path: '$.items.0.done', operator: 'equals', expected: true },
        matched: true
    },
    { name: 'array length', value: ['a', 'b'], condition: { source: 'value', path: 'length', operator: 'gte', expected: 2 }, matched: true },
    { name: 'string length', value: 'abc', condition: { source: 'value', path: 'length', operator: 'lte', expected: 2 }, matched: false },
    {
        name: 'missing nested field',
        value: { items: [] },
        condition: { source: 'value', path: 'items.0', operator: 'notEquals', expected: null },
        matched: true
    },
    { name: 'explicit null exists', value: { item: null }, condition: { source: 'value', path: 'item', operator: 'exists' }, matched: true },
    { name: 'absent field does not exist', value: {}, condition: { source: 'value', path: 'item', operator: 'exists', expected: false }, matched: true },
    { name: 'prototype is not document data', value: {}, condition: { source: 'value', path: 'constructor', operator: 'exists' }, matched: false },
    {
        name: 'array contains structural JSON',
        value: [{ title: 'ready' }],
        condition: { source: 'value', operator: 'contains', expected: { title: 'ready' } },
        matched: true
    },
    { name: 'object contains value', value: { count: 2 }, condition: { source: 'value', operator: 'contains', expected: 2 }, matched: true },
    { name: 'string contains rendered number', value: 'revision 2', condition: { source: 'value', operator: 'contains', expected: 2 }, matched: true },
    { name: 'numeric predicate does not coerce strings', value: '2', condition: { source: 'value', operator: 'gte', expected: 1 }, matched: false },
    {
        name: 'health uses its own source',
        value: { pendingUpdateCount: 99 },
        condition: { source: 'health', path: 'pendingUpdateCount', operator: 'equals', expected: 0 },
        matched: true
    }
];

it.each(cases)('evaluates $name', ({ value, condition, matched }) => {
    expect(matchesBlackBoxRallarCrdtWaitCondition(condition, value, {
        replicaId: 'replica',
        pendingUpdateCount: 0,
        failedPendingUpdateCount: 0,
        dependencyBlockedUpdateCount: 0,
        seenUpdateCount: 0
    })).toBe(matched);
});

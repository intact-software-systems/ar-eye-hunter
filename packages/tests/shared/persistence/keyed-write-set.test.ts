import { describe, expect, it } from 'vitest';

import { KeyedWriteSet } from '@shared/persistence/keyed-write-set.ts';

interface NamedValue {
    readonly name: string;
}

describe('transaction-local keyed writes', () => {
    it('distinguishes untouched keys, removals, and staged undefined values', () => {
        const writes = new KeyedWriteSet<string, undefined>();
        expect(writes.lookup('key')).toEqual({ kind: 'untouched' });
        writes.set('key', undefined);
        expect(writes.lookup('key')).toEqual({ kind: 'value', value: undefined });
        writes.remove('key');
        expect(writes.lookup('key')).toEqual({ kind: 'removed' });
        writes.set('key', undefined);
        expect(writes.lookup('key')).toEqual({ kind: 'value', value: undefined });
    });

    it('overlays last writes in first-mutation order after unshadowed stored entries', () => {
        const original = Object.freeze({ name: 'stored' });
        const replacement = Object.freeze({ name: 'replacement' });
        const latest = Object.freeze({ name: 'latest' });
        const stored = Object.freeze([
            Object.freeze({ key: 'replaced', value: original }),
            Object.freeze({ key: 'kept', value: original }),
            Object.freeze({ key: 'deleted', value: original })
        ]);
        const writes = new KeyedWriteSet<string, NamedValue>();
        writes.set('replaced', replacement);
        writes.remove('deleted');
        writes.set('new', replacement);
        writes.remove('replaced');
        writes.set('replaced', latest);
        writes.set('new', latest);

        const overlaid = writes.overlay(stored);
        expect(overlaid).toEqual([
            { kind: 'stored', key: 'kept', value: original },
            { kind: 'staged', key: 'replaced', value: latest },
            { kind: 'staged', key: 'new', value: latest }
        ]);
        expect(overlaid[0]?.value).toBe(original);
        expect(overlaid[1]?.value).toBe(latest);
        expect(overlaid[2]?.value).toBe(latest);
        expect(stored.map((entry) => entry.key)).toEqual(['replaced', 'kept', 'deleted']);
        expect(writes.mutations()).toEqual([
            ['replaced', { kind: 'value', value: latest }],
            ['deleted', { kind: 'removed' }],
            ['new', { kind: 'value', value: latest }]
        ]);
    });

    it('shadows a stored row with a staged undefined payload and retains removal tombstones', () => {
        const writes = new KeyedWriteSet<number, undefined>();
        writes.remove(1);
        writes.set(2, undefined);
        expect(writes.overlay([{ key: 1, value: 'old' }, { key: 2, value: 'old' }])).toEqual([
            { kind: 'staged', key: 2, value: undefined }
        ]);
        expect(writes.lookup(1)).toEqual({ kind: 'removed' });
        expect(writes.overlay([{ key: 1, value: 'later' }])).toEqual([
            { kind: 'staged', key: 2, value: undefined }
        ]);
    });
});

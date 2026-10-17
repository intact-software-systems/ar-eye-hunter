import { describe, expect, it } from 'vitest';

import { TO_ERROR_SUMMARY_LINE_MAX_LENGTH, toErrorSummaryLine } from '@shared/resilience/to-error.ts';

interface HeldEntry {
    key?: string;
    revision?: bigint;
    payload?: string;
    self?: HeldEntry;
}

class EntryError extends Error {
    readonly entry: HeldEntry;

    constructor(entry: HeldEntry) {
        super('Runtime state conditional write conflict');
        this.name = 'RuntimeStateWriteConflictError';
        this.entry = entry;
    }
}

describe('toErrorSummaryLine', () => {
    it('summarizes an error chain on one line, without stack frames', () => {
        const line = toErrorSummaryLine(new EntryError({ key: 'a', revision: 3n }));

        expect(line).toContain('RuntimeStateWriteConflictError');
        expect(line).toContain('"revision":"3"');
        expect(line).not.toContain('\n');
    });

    // The line is built inside the release of a conflicting row: a throw there would leave the row leased.
    it('falls back to the name and message when a property cannot be serialized', () => {
        const cyclic: HeldEntry = { key: 'a' };
        cyclic.self = cyclic;

        expect(toErrorSummaryLine(new EntryError(cyclic)))
            .toBe('RuntimeStateWriteConflictError: Runtime state conditional write conflict');
    });

    it('caps a long summary', () => {
        const line = toErrorSummaryLine(new EntryError({ payload: 'x'.repeat(10_000) }));

        expect(line.length).toBe(TO_ERROR_SUMMARY_LINE_MAX_LENGTH);
        expect(line.endsWith('…')).toBe(true);
    });
});

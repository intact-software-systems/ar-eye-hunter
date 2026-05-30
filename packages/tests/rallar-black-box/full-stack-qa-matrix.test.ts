import { describe, expect, it } from 'vitest';
import {
    FULL_STACK_QA_MATRIX,
    fullStackQaCoverageSummary,
} from '../../../apps/rallar-black-box/src/full-stack-qa-matrix.ts';

describe('rallar-black-box full-stack QA matrix', () => {
    it('keeps every matrix entry skip-gated and mapped to a spec', () => {
        const summary = fullStackQaCoverageSummary();

        expect(summary.coveragePercent).toBe(100);
        expect(summary.missingIds).toEqual([]);
        expect(FULL_STACK_QA_MATRIX.some(entry => entry.polarity === 'negative')).toBe(true);
        expect(FULL_STACK_QA_MATRIX.some(entry => entry.area === 'rtc' && entry.liveProvider)).toBe(true);
    });
});

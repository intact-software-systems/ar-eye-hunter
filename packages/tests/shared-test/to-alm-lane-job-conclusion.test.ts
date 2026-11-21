import { describe, expect, it } from 'vitest';

import { toAlmLaneJobConclusion } from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-job-conclusion.ts';

describe('toAlmLaneJobConclusion', () => {
    it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])(
        'reads a %s job as in progress, whatever its conclusion says',
        (status) => {
            expect(toAlmLaneJobConclusion({ status, conclusion: null })).toBe('in-progress');
            expect(toAlmLaneJobConclusion({ status, conclusion: 'success' })).toBe('in-progress');
        }
    );

    it('reads a completed job without a conclusion as in progress', () => {
        expect(toAlmLaneJobConclusion({ status: 'completed', conclusion: null })).toBe('in-progress');
    });

    it.each(
        [
            ['success', 'success'],
            ['skipped', 'skipped'],
            ['cancelled', 'cancelled'],
            ['failure', 'failure'],
            ['timed_out', 'failure'],
            ['neutral', 'failure'],
            ['action_required', 'failure'],
            ['stale', 'failure'],
            ['startup_failure', 'failure'],
            ['a conclusion GitHub adds later', 'failure']
        ] as const
    )('reads a completed job that concluded %s as %s', (conclusion, expected) => {
        expect(toAlmLaneJobConclusion({ status: 'completed', conclusion })).toBe(expected);
    });
});

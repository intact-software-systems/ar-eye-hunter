import { describe, expect, it } from 'vitest';

import { computeAlmLaneCarrierConclusion } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-carrier-conclusion.ts';
import {
    toAlmLaneJobConclusion,
    type AlmLaneReportedJob
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-job-conclusion.ts';

function toJob(conclusion: string | null): AlmLaneReportedJob {
    return {
        name: 'ALM conformance observation (rtc)',
        status: conclusion === null ? 'in_progress' : 'completed',
        conclusion
    };
}

describe('computeAlmLaneCarrierConclusion', () => {
    it.each(['success', 'failure', 'timed_out', 'cancelled', 'skipped', null])(
        'reads one job that concluded %s exactly as that job alone',
        (conclusion) => {
            expect(computeAlmLaneCarrierConclusion([toJob(conclusion)])).toBe(toAlmLaneJobConclusion(toJob(conclusion)));
        }
    );

    it.each(
        [
            [[null, 'cancelled'], 'in-progress'],
            [['failure', null], 'in-progress'],
            [['cancelled', 'failure'], 'cancelled'],
            [['success', 'cancelled'], 'cancelled'],
            [['success', 'failure'], 'failure'],
            [['timed_out', 'success'], 'failure'],
            [['success', 'skipped'], 'failure'],
            [['skipped', 'failure'], 'failure'],
            [['success', 'success'], 'success'],
            [['skipped', 'skipped'], 'skipped']
        ] as const
    )('reads jobs that concluded %j as %s', (conclusions, expected) => {
        const [first, ...rest] = conclusions;

        expect(computeAlmLaneCarrierConclusion([toJob(first), ...rest.map(toJob)])).toBe(expected);
    });
});

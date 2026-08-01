import { describe, expect, it } from 'vitest';

import { withBoundedArtifactReportResults } from '@shared-test/black-box-runner/artifacts/with-bounded-artifact-report-results.ts';

describe('black-box artifact report result bounds', () => {
    it('preserves every failure and full report counts while omitting bulky successes', () => {
        const successes = Array.from({ length: 3 }, (_, index) => ({
            resultKey: `success-${index}`, name: 'load', status: 'SUCCESS', actual: { bulky: 'x' },
        }));
        const failure = { resultKey: 'failure-1', name: 'gate', status: 'FAILURE' };
        const report = {
            outputs: { stateWriteEvidence: { atomicCompletionFailures: 0 } },
            results: {}, resultsByName: {}, resultsList: [...successes, failure], artifact: {},
        };

        const bounded = withBoundedArtifactReportResults(report, 2);

        expect(bounded.resultsList).toEqual([successes[0], failure]);
        expect(bounded.results).toEqual({ 'success-0': successes[0], 'failure-1': failure });
        expect(bounded.resultsByName).toEqual({ load: [successes[0]], gate: [failure] });
        expect(bounded.outputs).toBe(report.outputs);
        expect(bounded.artifact).toMatchObject({
            reportResultsTotal: 4, reportResultsEmitted: 2,
            reportResultsOmitted: 2, reportResultsTruncated: true,
        });
    });

    it('leaves reports unchanged when no valid bound is configured', () => {
        const report = { resultsList: [{ status: 'SUCCESS' }] };
        expect(withBoundedArtifactReportResults(report, undefined)).toBe(report);
    });
});

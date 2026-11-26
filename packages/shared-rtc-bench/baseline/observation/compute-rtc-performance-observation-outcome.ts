import { isRtcBaselineJobBudgetOutcome } from '../acceptance/rtc-baseline-job-budget-not-started.ts';
import type { RtcBaselineFinalizedSummary } from '../evidence/rtc-baseline-finalized-evidence.ts';
import type { RtcPerformanceObservationOutcome } from './rtc-performance-observation.ts';

/**
 * A finalized capture passed when every outcome it accounts for passed. It is incomplete when it accounts for none, or
 * when the job budget alone left the rest unfinished, and failed when an attempt it ran failed. The observation runners
 * declare this outcome and the archive verifier derives it again from the archived evidence.
 */
export function computeRtcPerformanceObservationOutcome(
    summary: Pick<RtcBaselineFinalizedSummary, 'sampleOutcomes' | 'cohortOutcomes'>
): RtcPerformanceObservationOutcome {
    const outcomes = [...summary.sampleOutcomes, ...summary.cohortOutcomes];
    const unpassed = outcomes.filter(({ outcome }) => outcome !== 'passed');
    if (outcomes.length === 0 || (unpassed.length > 0 && unpassed.every(isRtcBaselineJobBudgetOutcome))) {
        return 'incomplete';
    }
    return unpassed.length > 0 ? 'failed' : 'passed';
}

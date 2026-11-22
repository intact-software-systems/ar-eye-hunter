import type { AlmLaneJobConclusion } from './compute-alm-lane-run-reading.ts';
import { toAlmLaneJobConclusion, type AlmLaneReportedJob } from './to-alm-lane-job-conclusion.ts';

/**
 * The one conclusion of a carrier's jobs in one workflow run. Some jobs skipped beside others that ran is a failure,
 * so a carrier half of whose families never ran cannot read as skipped or green.
 */
export function computeAlmLaneCarrierConclusion(
    jobs: readonly Pick<AlmLaneReportedJob, 'status' | 'conclusion'>[]
): AlmLaneJobConclusion {
    const conclusions = jobs.map(toAlmLaneJobConclusion);
    const skipped = conclusions.filter((conclusion) => conclusion === 'skipped').length;
    if (conclusions.includes('in-progress')) {
        return 'in-progress';
    }
    if (conclusions.includes('cancelled')) {
        return 'cancelled';
    }
    if (conclusions.includes('failure') || (skipped > 0 && skipped < conclusions.length)) {
        return 'failure';
    }
    return skipped === conclusions.length ? 'skipped' : 'success';
}

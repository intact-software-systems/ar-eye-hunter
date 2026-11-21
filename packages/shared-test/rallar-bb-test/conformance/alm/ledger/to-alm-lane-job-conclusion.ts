import type { AlmLaneJobConclusion } from './compute-alm-lane-ledger.ts';

/** A job as the GitHub jobs API reports it. */
export interface AlmLaneReportedJob {
    readonly name: string;
    readonly status: string;
    /** Null while the job runs. */
    readonly conclusion: string | null;
}

/**
 * GitHub's job conclusion in the ledger's terms. Every completed conclusion other than success, skipped and cancelled
 * (a time-out, a startup failure, and any GitHub adds later) is a failure, so an unknown one cannot read as green.
 */
export function toAlmLaneJobConclusion(job: Pick<AlmLaneReportedJob, 'status' | 'conclusion'>): AlmLaneJobConclusion {
    if (job.status !== 'completed' || job.conclusion === null) {
        return 'in-progress';
    }
    if (job.conclusion === 'success' || job.conclusion === 'skipped' || job.conclusion === 'cancelled') {
        return job.conclusion;
    }
    return 'failure';
}

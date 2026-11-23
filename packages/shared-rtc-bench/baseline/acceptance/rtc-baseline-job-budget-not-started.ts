import type {
    RtcBaselineCaptureManifestDto,
    RtcBaselineFailureArtifact,
    RtcBaselineIssueDto,
    RtcBaselineNotRunArtifact,
    RtcBaselineSampleFailureOwner
} from '../contracts/rtc-baseline-contracts.ts';
import { rtcBaselineIssue } from '../contracts/rtc-baseline-contracts.ts';
import {
    createRtcBaselineFailureArtifact,
    createRtcBaselineNotRunArtifact,
    deriveRtcBaselineSampleIdentities,
    rtcBaselineSampleIdentityEquals
} from './rtc-baseline-failure-accounting.ts';

/**
 * The cause an attempt the capture never started for its job budget names. No attempt failed, so no failure artifact
 * carries this id; it stands where a not-run receipt otherwise names the failure that stopped its workload.
 */
export const RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ID = 'not-started-job-budget';

export const RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ISSUE = rtcBaselineIssue(
    '$',
    'not-started-job-budget',
    'Not started: the job budget left could not cover the attempt\'s test timeout.'
);

export const RTC_BASELINE_JOB_BUDGET_COHORT_ISSUE = rtcBaselineIssue(
    '$.identity.memberSampleIds',
    'cohort-members-not-started-job-budget',
    'Cohort assertion cannot run while a member attempt was not started for the job budget.'
);

const JOB_BUDGET_ISSUE_CODES: ReadonlySet<string> = new Set([
    RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ISSUE.code,
    RTC_BASELINE_JOB_BUDGET_COHORT_ISSUE.code
]);

/**
 * The first unstarted attempt's samples and every later sample of its workload are not run for the job budget, and a
 * cohort with any of them as a member cannot be asserted.
 */
export function buildRtcBaselineJobBudgetNotStartedSequence(
    manifest: RtcBaselineCaptureManifestDto,
    owner: RtcBaselineSampleFailureOwner
): (RtcBaselineNotRunArtifact | RtcBaselineFailureArtifact)[] {
    const identities = deriveRtcBaselineSampleIdentities(manifest.outerAttempts).filter(
        (identity) => identity.workloadId === owner.identity.workloadId
    );
    const ownerIndex = identities.findIndex((identity) => rtcBaselineSampleIdentityEquals(identity, owner.identity));
    const notStarted = identities.slice(ownerIndex);
    const notStartedSampleIds = new Set(notStarted.map((identity) => identity.sampleId));
    return [
        ...notStarted.map((identity) =>
            createRtcBaselineNotRunArtifact(identity, RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ID, [
                RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ISSUE
            ])
        ),
        ...manifest.expectedCohorts.flatMap((identity) => {
            const blockedMemberSampleIds = identity.memberSampleIds.filter((sampleId) =>
                notStartedSampleIds.has(sampleId)
            );
            return blockedMemberSampleIds.length === 0 ? [] : [
                createRtcBaselineFailureArtifact({ kind: 'cohort', identity }, [RTC_BASELINE_JOB_BUDGET_COHORT_ISSUE], {
                    causalFailureId: RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ID,
                    blockedMemberSampleIds
                })
            ];
        })
    ];
}

/** An outcome the job budget left unfinished, rather than one an attempt failed. */
export function isRtcBaselineJobBudgetOutcome(outcome: { readonly issues: readonly RtcBaselineIssueDto[]; }): boolean {
    return outcome.issues.length > 0 && outcome.issues.every((issue) => JOB_BUDGET_ISSUE_CODES.has(issue.code));
}

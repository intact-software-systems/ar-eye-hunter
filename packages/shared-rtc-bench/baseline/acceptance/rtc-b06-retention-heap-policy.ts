import type { RtcBaselineIssueDto, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';

export interface RtcB06RetentionHeapPolicy {
    readonly requiredHeapBreachCount: number;
    readonly warnings: readonly RtcBaselineIssueDto[];
}

export function computeRtcB06RetentionHeapPolicy(
    retainedAttemptCount: number,
    heapBreachingSampleIds: readonly string[]
): RtcBaselineResult<RtcB06RetentionHeapPolicy> {
    if (retainedAttemptCount !== 3 && retainedAttemptCount !== 6) {
        return {
            ok: false,
            issues: [{
                path: '$.rawEvidence.retainedAttemptCount',
                code: 'invalid-retention-count',
                message: 'Live RTC retention cohort requires exactly 3 primary or 6 repeat samples.'
            }]
        };
    }
    const requiredHeapBreachCount = retainedAttemptCount === 3 ? 2 : 4;
    const warnings: RtcBaselineIssueDto[] = heapBreachingSampleIds.length < requiredHeapBreachCount
        ? []
        : [{
            path: '$.rawEvidence.heapBreachingSampleIds',
            code: 'retention-heap-threshold-breached',
            message:
                `${heapBreachingSampleIds.length} retained attempts breached the ${requiredHeapBreachCount}-attempt heap threshold.`
        }];
    return { ok: true, value: { requiredHeapBreachCount, warnings } };
}

import {
    LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS
} from '../../../shared-test/rallar-bb-test/browser-test-budgets/live-rtc-matrix-test-timeouts.ts';

/** Each RTC-B06 attempt runs the one matrix test its case selects, under the timeout that test derives. */
const RTC_B06_ATTEMPT_TEST_TIMEOUTS_MS: Readonly<Record<string, number>> = {
    default: LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    'all-scenarios': LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    'retention-100': LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS
};

/** The longest an RTC-B06 attempt's test may run; the catalog declares no case outside these three. */
export function toRtcB06AttemptTestTimeoutMs(caseId: string): number {
    const timeoutMs = RTC_B06_ATTEMPT_TEST_TIMEOUTS_MS[caseId];
    if (timeoutMs === undefined) {
        throw new Error(`RTC-B06 case ${caseId} has no derived test timeout.`);
    }
    return timeoutMs;
}

import { FULL_STACK_WEB_SERVERS_START_BOUNDED_WAITS_MS } from '../../../shared-test/rallar-bb-test/browser-test-budgets/full-stack-web-server-start-timeouts.ts';
import {
    LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS
} from '../../../shared-test/rallar-bb-test/browser-test-budgets/live-rtc-matrix-test-timeouts.ts';

/** Each RTC-B06 attempt runs the one matrix test its case selects, under the timeout that test derives. */
const RTC_B06_ATTEMPT_TEST_TIMEOUTS_MS = {
    default: LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    'all-scenarios': LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    'retention-100': LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS
} as const;

type RtcB06CaseId = keyof typeof RTC_B06_ATTEMPT_TEST_TIMEOUTS_MS;

/**
 * Before its test an attempt builds the app for production, which has no limit of its own. Release Gate runs
 * 45224498021, 45207491208 and 45273086131 built the same app (`npm --workspace rallar-black-box run build`, type check
 * included) in 3.5 s, 6.2 s and 6.3 s on hosted runners; this allows ten times the slowest and the attempt's sealing.
 */
export const RTC_B06_ATTEMPT_PRODUCTION_BUILD_MS = 60_000;

/** The longest an RTC-B06 attempt's test may run. */
export function toRtcB06AttemptTestTimeoutMs(caseId: string): number {
    assertRtcB06CaseId(caseId);
    return RTC_B06_ATTEMPT_TEST_TIMEOUTS_MS[caseId];
}

/** The longest an RTC-B06 attempt may take: its production build, its web servers' start, then its test. */
export function computeRtcB06AttemptTimeoutMs(caseId: string): number {
    return RTC_B06_ATTEMPT_PRODUCTION_BUILD_MS + FULL_STACK_WEB_SERVERS_START_BOUNDED_WAITS_MS +
        toRtcB06AttemptTestTimeoutMs(caseId);
}

/** The catalog declares no RTC-B06 case outside these three, so an attempt naming another is a programming error. */
function assertRtcB06CaseId(caseId: string): asserts caseId is RtcB06CaseId {
    if (!Object.hasOwn(RTC_B06_ATTEMPT_TEST_TIMEOUTS_MS, caseId)) {
        throw new Error(`RTC-B06 case ${caseId} has no derived test timeout.`);
    }
}

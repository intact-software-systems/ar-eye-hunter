import { CONTROL_REQUEST_TIMEOUT_MS } from './control-request-timeout-ms.ts';
import { LIVE_RTC_TRIO_SIZE } from './live-rtc-control-waits.ts';

/** How long one read of a control run's recorder stream may take before the harness abandons it. */
export const LIVE_RTC_RECORDER_READ_TIMEOUT_MS = 30_000;

/**
 * A matrix test's artifact evidence requests the run's artifact bundle, then reads the run's results and its events
 * from the recorder.
 */
export const LIVE_RTC_ARTIFACT_EVIDENCE_BOUNDED_WAITS_MS = CONTROL_REQUEST_TIMEOUT_MS +
    2 * LIVE_RTC_RECORDER_READ_TIMEOUT_MS;

/**
 * Under Native capture each connect of a matrix test's two formation runs reads its acquisition from the recorder; a
 * reconnect requests none.
 */
export const LIVE_RTC_MATRIX_NATIVE_ACQUISITION_BOUNDED_WAITS_MS = 2 * LIVE_RTC_TRIO_SIZE *
    LIVE_RTC_RECORDER_READ_TIMEOUT_MS;

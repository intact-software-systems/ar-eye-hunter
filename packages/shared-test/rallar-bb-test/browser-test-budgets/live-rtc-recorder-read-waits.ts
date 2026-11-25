import { LIVE_RTC_TRIO_SIZE } from './live-rtc-control-waits.ts';

/** How long one read of a control run's recorder stream may take before the harness abandons it. */
export const LIVE_RTC_RECORDER_READ_TIMEOUT_MS = 30_000;

/** A matrix test's artifact evidence reads the run's results, then its events, from the recorder. */
export const LIVE_RTC_ARTIFACT_EVIDENCE_BOUNDED_WAITS_MS = 2 * LIVE_RTC_RECORDER_READ_TIMEOUT_MS;

/** Under Native capture each formation connect of the proof's two matrices reads its acquisition from the recorder. */
export const LIVE_RTC_PROOF_NATIVE_ACQUISITION_BOUNDED_WAITS_MS = 2 * LIVE_RTC_TRIO_SIZE *
    LIVE_RTC_RECORDER_READ_TIMEOUT_MS;

/** The every-scenario test's two formations' connects, then C's reconnect, each read their acquisition. */
export const LIVE_RTC_ALL_SCENARIOS_NATIVE_ACQUISITION_BOUNDED_WAITS_MS = (2 * LIVE_RTC_TRIO_SIZE + 1) *
    LIVE_RTC_RECORDER_READ_TIMEOUT_MS;

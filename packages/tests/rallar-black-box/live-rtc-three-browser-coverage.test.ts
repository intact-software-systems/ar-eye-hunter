import { describe, expect, it } from 'vitest';
import { LIVE_RTC_THREE_BROWSER_COVERAGE, liveRtcThreeBrowserCoverageSummary } from '../../../apps/rallar-black-box/src/live-rtc-three-browser-coverage.ts';

describe('rallar-black-box live three-browser RTC coverage', () => {
    it('keeps required live matrix coverage above 90 percent', () => {
        const summary = liveRtcThreeBrowserCoverageSummary();

        expect(summary.requiredCoveragePercent).toBeGreaterThan(90);
        expect(summary.missingRequiredIds).toEqual([]);
        expect(summary.coveragePercent).toBeGreaterThan(90);
        expect(summary.missingOptionalIds).toEqual(['permission-denied-negative']);
        expect(LIVE_RTC_THREE_BROWSER_COVERAGE.some((entry) => entry.area === 'negative')).toBe(true);
    });
});

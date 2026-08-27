import { describe, expect, it } from 'vitest';

import { RtcTopologyPlanner } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts';

function createPlanner(): RtcTopologyPlanner {
    return new RtcTopologyPlanner({}, { metrics: new RtcTopologyMetrics(), durationNowMs: () => 0 });
}

describe('RTC topology RTT reporting degree limit resolution', () => {
    // A reporting limit below the planning degree limit structurally rejects
    // evidence for planned edges, so a raised per-group planning limit must
    // raise the reporting limit with it even when the server sets its own
    // reporting value (the api-v1 configuration always does).
    it('never resolves the reporting limit below the effective planning degree limit', () => {
        const resolved = createPlanner().readRttReportingDegreeLimit({
            degreeLimit: 24,
            rttReportingDegreeLimit: 5
        });

        expect(resolved).toBe(24);
    });

    it('lets the server reporting value raise the limit above the planning degree', () => {
        const resolved = createPlanner().readRttReportingDegreeLimit({
            degreeLimit: 5,
            rttReportingDegreeLimit: 12
        });

        expect(resolved).toBe(12);
    });

    it('resolves matching planning and reporting values unchanged', () => {
        const resolved = createPlanner().readRttReportingDegreeLimit({
            degreeLimit: 5,
            rttReportingDegreeLimit: 5
        });

        expect(resolved).toBe(5);
    });

    it('falls back to the planning degree limit when no server reporting value is set', () => {
        const resolved = createPlanner().readRttReportingDegreeLimit({
            degreeLimit: 8
        });

        expect(resolved).toBe(8);
    });
});

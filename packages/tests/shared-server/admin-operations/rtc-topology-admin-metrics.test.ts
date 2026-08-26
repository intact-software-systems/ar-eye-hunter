import { describe, expect, it } from 'vitest';

import { createApiRtcTopologyAdminMetrics } from '../../../../apps/api-v1/src/runtime/rtc-topology/create-api-rtc-topology-admin-metrics.ts';

describe('API RTC topology admin metrics', () => {
    it('nests replay diagnostics under the topology metrics', () => {
        const { metrics } = createMetricsHarness();

        expect(metrics.read()).toEqual({
            topologyUpdateCount: 3,
            replay: { drainAttemptCount: 4 }
        });
    });

    it('resets planning and replay metrics through their owners', () => {
        const { metrics } = createMetricsHarness();

        metrics.reset();

        expect(metrics.read()).toEqual({
            topologyUpdateCount: 0,
            replay: { drainAttemptCount: 0 }
        });
    });
});

function createMetricsHarness() {
    let topologyUpdateCount = 3;
    let drainAttemptCount = 4;
    const metrics = createApiRtcTopologyAdminMetrics({
        planning: {
            readMetrics: () => ({ topologyUpdateCount }),
            resetMetrics: () => {
                topologyUpdateCount = 0;
            }
        },
        replay: {
            readMetrics: () => ({ drainAttemptCount }),
            resetMetrics: () => {
                drainAttemptCount = 0;
            }
        }
    });
    return { metrics };
}

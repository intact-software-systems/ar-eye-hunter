import { describe, expect, it, vi } from 'vitest';

import { createApiRtcTopologyAdminMetrics } from '../../../../apps/api-v1/src/runtime/rtc-topology/create-api-rtc-topology-admin-metrics.ts';

describe('API RTC topology admin metrics', () => {
    it('nests replay diagnostics under existing topology metrics and resets both owners', () => {
        const planningReset = vi.fn();
        const replayReset = vi.fn();
        const metrics = createApiRtcTopologyAdminMetrics({
            planning: {
                readMetrics: () => ({ topologyUpdateCount: 3 }),
                resetMetrics: planningReset
            },
            replay: {
                readMetrics: () => ({ drainAttemptCount: 4 }),
                resetMetrics: replayReset
            }
        });

        expect(metrics.read()).toEqual({
            topologyUpdateCount: 3,
            replay: { drainAttemptCount: 4 }
        });
        metrics.reset();
        expect(planningReset).toHaveBeenCalledOnce();
        expect(replayReset).toHaveBeenCalledOnce();
    });
});

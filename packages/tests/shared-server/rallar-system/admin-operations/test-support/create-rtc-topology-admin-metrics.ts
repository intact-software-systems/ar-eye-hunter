import type {
    RtcTopologyAdminMetrics,
    RtcTopologyAdminReplayMetrics
} from '@shared/rtc/rtc-topology-admin-metrics.ts';

import { createRtcTopologyReplayDiagnostics } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-diagnostics.ts';
import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts';

export function createRtcTopologyAdminReplayMetrics(
    overrides: Partial<RtcTopologyAdminReplayMetrics> = {}
): RtcTopologyAdminReplayMetrics {
    return { ...createRtcTopologyReplayDiagnostics().readMetrics(), ...overrides };
}

export function createRtcTopologyAdminMetrics(
    overrides: Partial<Omit<RtcTopologyAdminMetrics, 'replay'>> = {}
): RtcTopologyAdminMetrics {
    return {
        ...new RtcTopologyMetrics().read(0),
        ...overrides,
        replay: createRtcTopologyAdminReplayMetrics()
    };
}

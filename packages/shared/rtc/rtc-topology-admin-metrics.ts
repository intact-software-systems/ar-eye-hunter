import type { RallarRtcTopologyMetrics } from './rallar-rtc-topology-metrics.ts';
import type { RtcTopologyReplayMetrics } from './rtc-topology-replay-metrics.ts';

/** The RTC topology counters the admin operations report: the planning counters, with the replay consumer's under `replay`. */
export interface RtcTopologyAdminMetrics extends RallarRtcTopologyMetrics {
    readonly replay: RtcTopologyReplayMetrics;
}

import {
    RtcTopologyDeliveryStreamService,
    type RtcTopologyDeliveryStreamMaintenancePort,
    type RtcTopologyDeliveryStreamScheduler
} from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-stream-service.ts';
import type { ApiV1TopologyDeliveryConfiguration } from '../../configuration/api-v1-configuration.ts';

interface ApiRtcTopologyDeliveryStartupOptions {
    readonly streamId: string;
    readonly repository: RtcTopologyDeliveryStreamMaintenancePort;
    readonly configuration: ApiV1TopologyDeliveryConfiguration;
    readonly scheduler?: RtcTopologyDeliveryStreamScheduler;
    readonly onCompactionFailure?: (error: Error) => void;
}

export interface ApiRtcTopologyDeliveryLifecycle {
    readonly readiness: Promise<void>;
    readonly healthFailure: Promise<never>;
    stop(): void;
}

export function startApiRtcTopologyDelivery(
    options: ApiRtcTopologyDeliveryStartupOptions
): ApiRtcTopologyDeliveryLifecycle {
    let rejectHealthFailure: (error: Error) => void = () => undefined;
    const healthFailure = new Promise<never>((_resolve, reject) => {
        rejectHealthFailure = reject;
    });
    void healthFailure.catch(() => undefined);

    const service = new RtcTopologyDeliveryStreamService({
        streamId: options.streamId,
        repository: options.repository,
        policy: {
            heartbeatIntervalMs: options.configuration.heartbeatIntervalMs,
            leaseDurationMs: options.configuration.leaseDurationMs,
            compactionIntervalMs: options.configuration.compactionIntervalMs,
            compactionPageSize: options.configuration.compactionPageSize,
            consumerRetentionMs: options.configuration.consumerRetentionMs
        },
        scheduler: options.scheduler,
        onHealthFailure: rejectHealthFailure,
        onCompactionFailure: options.onCompactionFailure
    });
    return {
        readiness: service.start(),
        healthFailure,
        stop: () => service.stop()
    };
}

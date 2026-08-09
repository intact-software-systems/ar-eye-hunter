import {
  type RtcTopologyDeliveryStreamMaintenancePort,
  type RtcTopologyDeliveryStreamScheduler,
  RtcTopologyDeliveryStreamService,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-stream-service.ts';

interface ApiRtcTopologyDeliveryStartupOptions {
  readonly streamId: string;
  readonly repository: RtcTopologyDeliveryStreamMaintenancePort;
  readonly scheduler?: RtcTopologyDeliveryStreamScheduler;
  readonly onCompactionFailure?: (error: Error) => void;
}

export interface ApiRtcTopologyDeliveryLifecycle {
  readonly readiness: Promise<void>;
  readonly healthFailure: Promise<never>;
  stop(): void;
}

export function startApiRtcTopologyDelivery(
  options: ApiRtcTopologyDeliveryStartupOptions,
): ApiRtcTopologyDeliveryLifecycle {
  let rejectHealthFailure: (error: Error) => void = () => undefined;
  const healthFailure = new Promise<never>((_resolve, reject) => {
    rejectHealthFailure = reject;
  });
  void healthFailure.catch(() => undefined);

  const service = new RtcTopologyDeliveryStreamService({
    streamId: options.streamId,
    repository: options.repository,
    scheduler: options.scheduler,
    onHealthFailure: rejectHealthFailure,
    onCompactionFailure: options.onCompactionFailure,
  });
  return {
    readiness: service.start(),
    healthFailure,
    stop: () => service.stop(),
  };
}

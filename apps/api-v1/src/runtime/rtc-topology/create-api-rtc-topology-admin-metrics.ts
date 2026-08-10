interface RtcTopologyMetricsOwner<TMetrics extends object> {
  readMetrics(): TMetrics;
  resetMetrics(): void;
}

interface ApiRtcTopologyAdminMetricsInput<
  TPlanningMetrics extends object,
  TReplayMetrics extends object,
> {
  readonly planning: RtcTopologyMetricsOwner<TPlanningMetrics>;
  readonly replay: RtcTopologyMetricsOwner<TReplayMetrics>;
}

export function createApiRtcTopologyAdminMetrics<
  TPlanningMetrics extends object,
  TReplayMetrics extends object,
>(input: ApiRtcTopologyAdminMetricsInput<TPlanningMetrics, TReplayMetrics>): Readonly<{
  read(): TPlanningMetrics & Readonly<{ replay: TReplayMetrics }>;
  reset(): void;
}> {
  return {
    read: () => ({ ...input.planning.readMetrics(), replay: input.replay.readMetrics() }),
    reset: () => {
      input.planning.resetMetrics();
      input.replay.resetMetrics();
    },
  };
}

interface RtcTopologyMetricsOwner<TMetrics extends object> {
  readMetrics(): TMetrics;
  resetMetrics(): void;
}

interface ApiRtcTopologyAdminMetricsInput<
  TPlanning extends object,
  TReplay extends object,
> {
  readonly planning: RtcTopologyMetricsOwner<TPlanning>;
  readonly replay: RtcTopologyMetricsOwner<TReplay>;
}

export function createApiRtcTopologyAdminMetrics<
  TPlanning extends object,
  TReplay extends object,
>(input: ApiRtcTopologyAdminMetricsInput<TPlanning, TReplay>) {
  return {
    read: (): TPlanning & Readonly<{ replay: TReplay }> => ({
      ...input.planning.readMetrics(),
      replay: input.replay.readMetrics(),
    }),
    reset: (): void => {
      input.planning.resetMetrics();
      input.replay.resetMetrics();
    },
  };
}

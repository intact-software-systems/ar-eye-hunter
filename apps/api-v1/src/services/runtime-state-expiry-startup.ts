export type RuntimeStateExpiryStartupBarrierOptions = Readonly<{
  backfillTopologyGenerations: () => Promise<Readonly<{ advanced: number }>>;
  initialiseRuntimeStateExpiryEviction: () => Promise<void>;
  onGenerationsBackfilled?: (advanced: number) => void;
}>;

/**
 * Keeps generic runtime-state expiry fail-closed until legacy topology
 * config/override generations have been preserved outside expiring rows.
 */
export async function runRuntimeStateExpiryStartupBarrier(
  options: RuntimeStateExpiryStartupBarrierOptions,
): Promise<void> {
  const { advanced } = await options.backfillTopologyGenerations();
  options.onGenerationsBackfilled?.(advanced);
  await options.initialiseRuntimeStateExpiryEviction();
}

export type RuntimeStateExpiryStartupBarrierOptions = Readonly<{
  backfillTopologyGenerations: () => Promise<Readonly<{ advanced: number }>>;
  initialiseRtcRttReceiptFamilyCleanup: () => Promise<void>;
  initialiseRuntimeStateExpiryEviction: () => Promise<void>;
  onGenerationsBackfilled?: (advanced: number) => void;
}>;

export type RuntimeStateExpiryCleanupHandle = Readonly<{
  firstRun: Promise<number>;
  stop(): void;
}>;

export type RuntimeStateExpiryLifecycle = Readonly<{
  startRtcRttReceiptFamilyCleanup(
    initialise: () => RuntimeStateExpiryCleanupHandle,
  ): Promise<number>;
  stop(): void;
}>;

export function createRuntimeStateExpiryLifecycle(): RuntimeStateExpiryLifecycle {
  let cleanup: RuntimeStateExpiryCleanupHandle | undefined;
  return {
    startRtcRttReceiptFamilyCleanup: async (initialise) => {
      const previous = cleanup;
      cleanup = undefined;
      previous?.stop();
      const current = initialise();
      cleanup = current;
      return await current.firstRun;
    },
    stop: () => {
      const current = cleanup;
      cleanup = undefined;
      current?.stop();
    },
  };
}

/**
 * Keeps generic runtime-state expiry fail-closed until legacy topology
 * config/override generations have been preserved outside expiring rows.
 */
export async function runRuntimeStateExpiryStartupBarrier(
  options: RuntimeStateExpiryStartupBarrierOptions,
): Promise<void> {
  const { advanced } = await options.backfillTopologyGenerations();
  options.onGenerationsBackfilled?.(advanced);
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    await options.initialiseRtcRttReceiptFamilyCleanup();
  } catch (error) {
    cleanupFailure = error;
    cleanupFailed = true;
  }
  try {
    await options.initialiseRuntimeStateExpiryEviction();
  } catch (evictionFailure) {
    if (cleanupFailed) {
      throw new AggregateError(
        [cleanupFailure, evictionFailure],
        'RTC family cleanup and protected generic runtime-state expiry startup failed',
      );
    }
    throw evictionFailure;
  }
  if (cleanupFailed) throw cleanupFailure;
}

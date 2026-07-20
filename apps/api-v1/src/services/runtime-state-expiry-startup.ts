export type RuntimeStateExpiryStartupBarrierOptions = Readonly<{
  backfillTopologyGenerations: () => Promise<Readonly<{ advanced: number }>>;
  initialiseRtcRttReceiptFamilyCleanup: () => Promise<void>;
  initialiseRuntimeStateExpiryEviction: () => Promise<number>;
  onGenerationsBackfilled?: (advanced: number) => void;
  isCurrentGeneration?: () => boolean;
  onDetachedRuntimeStateExpiryEvictionFailure?: (error: unknown) => void;
}>;

export type RuntimeStateExpiryCleanupHandle = Readonly<{
  firstRun: Promise<number>;
  stop(): void;
}>;

export type RuntimeStateExpiryLifecycle = Readonly<{
  beginStartupGeneration(): RuntimeStateExpiryStartupGeneration;
  startRtcRttReceiptFamilyCleanup(
    initialise: () => RuntimeStateExpiryCleanupHandle,
  ): Promise<number>;
  stop(): void;
}>;

export type RuntimeStateExpiryStartupGeneration = Readonly<{
  isCurrent(): boolean;
  startRtcRttReceiptFamilyCleanup(
    initialise: () => RuntimeStateExpiryCleanupHandle,
  ): Promise<number>;
  startRuntimeStateExpiryEviction(
    initialise: () => RuntimeStateExpiryCleanupHandle,
  ): Promise<number>;
}>;

export function createRuntimeStateExpiryLifecycle(): RuntimeStateExpiryLifecycle {
  let cleanup: RuntimeStateExpiryCleanupHandle | undefined;
  let eviction: RuntimeStateExpiryCleanupHandle | undefined;
  let token = 0;
  let invalidateCurrent: (() => void) | undefined;
  const stopCleanup = (): void => {
    const current = cleanup;
    cleanup = undefined;
    current?.stop();
  };
  const stopEviction = (): void => {
    const current = eviction;
    eviction = undefined;
    current?.stop();
  };
  const beginStartupGeneration = (): RuntimeStateExpiryStartupGeneration => {
    invalidateCurrent?.();
    stopCleanup();
    stopEviction();
    const reservedToken = ++token;
    let valid = true;
    let invalidate!: () => void;
    const invalidated = new Promise<void>((resolve) => {
      invalidate = () => {
        if (!valid) return;
        valid = false;
        resolve();
      };
    });
    invalidateCurrent = invalidate;
    const isCurrent = () => valid && reservedToken === token;
    const startOwned = async (
      kind: 'cleanup' | 'eviction',
      initialise: () => RuntimeStateExpiryCleanupHandle,
    ): Promise<number> => {
      const handle = initialise();
      if (!isCurrent()) {
        handle.stop();
        void handle.firstRun.catch(() => undefined);
        return 0;
      }
      if (kind === 'cleanup') {
        cleanup?.stop();
        cleanup = handle;
      } else {
        eviction?.stop();
        eviction = handle;
      }
      return await Promise.race([
        handle.firstRun,
        invalidated.then(() => 0),
      ]);
    };
    return {
      isCurrent,
      startRtcRttReceiptFamilyCleanup: (initialise) => startOwned('cleanup', initialise),
      startRuntimeStateExpiryEviction: (initialise) => startOwned('eviction', initialise),
    };
  };
  const lifecycle: RuntimeStateExpiryLifecycle = {
    beginStartupGeneration,
    startRtcRttReceiptFamilyCleanup: (initialise) =>
      beginStartupGeneration().startRtcRttReceiptFamilyCleanup(initialise),
    stop: () => {
      token += 1;
      invalidateCurrent?.();
      invalidateCurrent = undefined;
      stopCleanup();
      stopEviction();
    },
  };
  return lifecycle;
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
  if (options.isCurrentGeneration && !options.isCurrentGeneration()) return;
  let eviction: Promise<number>;
  try {
    eviction = options.initialiseRuntimeStateExpiryEviction();
  } catch (evictionFailure) {
    if (cleanupFailed) {
      throw new AggregateError(
        [cleanupFailure, evictionFailure],
        'RTC family cleanup and protected generic runtime-state expiry startup failed',
      );
    }
    throw evictionFailure;
  }
  if (cleanupFailed) {
    void eviction.catch((error) => {
      options.onDetachedRuntimeStateExpiryEvictionFailure?.(error);
    });
    throw cleanupFailure;
  }
  await eviction;
}

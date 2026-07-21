export type InProcessMutationLaneRunOptions<TResult = unknown> = Readonly<{
  signal?: AbortSignal;
  shouldHandoff?: (result: TResult) => boolean;
}>;

export type InProcessMutationLaneOptions = Readonly<{
  postSuccessHandoff?: () => Promise<void>;
}>;

export const IN_PROCESS_MUTATION_HANDOFF_MS = 3;

export type InProcessMutationLane = Readonly<{
  run<TResult>(
    key: string,
    effect: () => TResult | PromiseLike<TResult>,
    options?: InProcessMutationLaneRunOptions<TResult>,
  ): Promise<TResult>;
  pendingKeyCount(): number;
}>;

/**
 * Suppresses avoidable same-instance conflicts without becoming a correctness
 * boundary. Separate lane instances and processes still converge through the
 * conditional database writes performed by each effect.
 */
export function createInProcessMutationLane(
  laneOptions: InProcessMutationLaneOptions = {},
): InProcessMutationLane {
  const tails = new Map<string, Promise<void>>();

  return {
    run: <TResult>(
      key: string,
      effect: () => TResult | PromiseLike<TResult>,
      options: InProcessMutationLaneRunOptions<TResult> = {},
    ): Promise<TResult> => {
      const previous = tails.get(key) ?? Promise.resolve();
      let tail!: Promise<void>;
      const execute = () => {
        if (options.signal?.aborted) {
          throw mutationLaneAbortError(options.signal);
        }
        return effect();
      };
      const postSuccessHandoff = laneOptions.postSuccessHandoff;
      const result = postSuccessHandoff
        ? previous.then(async () => {
          const value = await execute();
          if (tails.get(key) !== tail) {
            try {
              if (options.shouldHandoff?.(value) ?? true) {
                await postSuccessHandoff();
              }
            } catch {
              // A best-effort scheduling handoff must not change a completed effect.
            }
          }
          return value;
        })
        : previous.then(execute);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      });
      return result;
    },
    pendingKeyCount: () => tails.size,
  };
}

/**
 * Gives a previously observed remote retry a small best-effort scheduling
 * window. This is not a retry delay, lock, or cross-process ordering guarantee.
 */
export function waitForInProcessMutationHandoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, IN_PROCESS_MUTATION_HANDOFF_MS));
}

function mutationLaneAbortError(signal: AbortSignal): Error {
  const error = new Error('Mutation lane effect aborted before acquisition', {
    cause: signal.reason,
  });
  error.name = 'AbortError';
  return error;
}

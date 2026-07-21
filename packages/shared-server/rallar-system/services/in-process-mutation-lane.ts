export type InProcessMutationLaneRunOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type InProcessMutationLane = Readonly<{
  run<TResult>(
    key: string,
    effect: () => TResult | PromiseLike<TResult>,
    options?: InProcessMutationLaneRunOptions,
  ): Promise<TResult>;
  pendingKeyCount(): number;
}>;

/**
 * Suppresses avoidable same-instance conflicts without becoming a correctness
 * boundary. Separate lane instances and processes still converge through the
 * conditional database writes performed by each effect.
 */
export function createInProcessMutationLane(): InProcessMutationLane {
  const tails = new Map<string, Promise<void>>();

  return {
    run: <TResult>(
      key: string,
      effect: () => TResult | PromiseLike<TResult>,
      options: InProcessMutationLaneRunOptions = {},
    ): Promise<TResult> => {
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(() => {
        if (options.signal?.aborted) {
          throw mutationLaneAbortError(options.signal);
        }
        return effect();
      });
      const tail = result.then(
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

function mutationLaneAbortError(signal: AbortSignal): Error {
  const error = new Error('Mutation lane effect aborted before acquisition', {
    cause: signal.reason,
  });
  error.name = 'AbortError';
  return error;
}

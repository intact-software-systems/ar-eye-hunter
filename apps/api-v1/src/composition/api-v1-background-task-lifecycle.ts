import type {
  RuntimeStateExpiryLifecycle,
  RuntimeStateExpiryStartupGeneration,
} from '../services/runtime-state-expiry-startup.ts';

export interface ApiV1BackgroundTaskLifecycle {
  beginStartupGeneration(): RuntimeStateExpiryStartupGeneration;
  register(stop: () => void | Promise<void>): () => void;
  stop(): Promise<void>;
}

export interface CreateApiV1BackgroundTaskLifecycleInput {
  readonly runtimeStateExpiry: RuntimeStateExpiryLifecycle;
}

type ApiV1BackgroundTaskStop = () => void | Promise<void>;

export function createApiV1BackgroundTaskLifecycle(
  input: CreateApiV1BackgroundTaskLifecycleInput,
): ApiV1BackgroundTaskLifecycle {
  const registeredStops = new Set<ApiV1BackgroundTaskStop>();
  let stopPromise: Promise<void> | undefined;

  return {
    beginStartupGeneration: () => input.runtimeStateExpiry.beginStartupGeneration(),
    register: (stop) => {
      if (stopPromise) {
        throw new Error('Cannot register an API-v1 background task after shutdown starts');
      }

      registeredStops.add(stop);
      return () => {
        registeredStops.delete(stop);
      };
    },
    stop: () => {
      stopPromise ??= stopApiV1BackgroundTasks(input.runtimeStateExpiry, registeredStops);
      return stopPromise;
    },
  };
}

async function stopApiV1BackgroundTasks(
  runtimeStateExpiry: RuntimeStateExpiryLifecycle,
  registeredStops: Set<ApiV1BackgroundTaskStop>,
): Promise<void> {
  const stops = [...registeredStops];
  registeredStops.clear();
  const failures: Error[] = [];

  try {
    runtimeStateExpiry.stop();
  } catch (error) {
    failures.push(toError(error));
  }

  const results = await Promise.allSettled(
    stops.map(async (stop) => await stop()),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(toError(result.reason));
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'API-v1 background task shutdown failed');
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

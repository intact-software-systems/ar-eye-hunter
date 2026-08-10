import { createRuntimeStateExpiryLifecycle } from './services/runtime-state-expiry-startup.ts';

const runtimeStateExpiryLifecycle = createRuntimeStateExpiryLifecycle();
type MiddlewareBackgroundTaskStop = () => void | Promise<void>;
const backgroundTaskStops = new Set<MiddlewareBackgroundTaskStop>();

export function beginMiddlewareStartupGeneration(): ReturnType<
  typeof runtimeStateExpiryLifecycle.beginStartupGeneration
> {
  return runtimeStateExpiryLifecycle.beginStartupGeneration();
}

export async function shutdownMiddlewareBackgroundTasks(): Promise<void> {
  const stops = [...backgroundTaskStops];
  backgroundTaskStops.clear();
  runtimeStateExpiryLifecycle.stop();
  await Promise.all(stops.map(async (stop) => await stop()));
}

export function registerMiddlewareBackgroundTask(
  stop: MiddlewareBackgroundTaskStop,
): () => void {
  backgroundTaskStops.add(stop);
  return () => backgroundTaskStops.delete(stop);
}

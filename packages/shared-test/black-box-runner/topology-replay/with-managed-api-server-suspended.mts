import type {
  ManagedApiServerLifecycleControls,
} from '../managed-api/with-managed-api-server-plans.mts';

export async function withManagedApiServerSuspended<T>(
  controls: ManagedApiServerLifecycleControls,
  port: number,
  run: () => Promise<T>,
): Promise<T> {
  await controls.suspend(port);
  try {
    return await run();
  } finally {
    await controls.resume(port);
  }
}

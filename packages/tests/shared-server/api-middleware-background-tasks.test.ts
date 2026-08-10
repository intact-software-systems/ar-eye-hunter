import { describe, expect, it } from 'vitest';

import {
  registerMiddlewareBackgroundTask,
  shutdownMiddlewareBackgroundTasks,
} from '../../../apps/api-v1/src/middleware.ts';

describe('API middleware background-task shutdown', () => {
  it('awaits asynchronous owners before shutdown completes', async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = false;
    registerMiddlewareBackgroundTask(async () => {
      await released;
      await Promise.resolve();
      stopped = true;
    });

    const shutdown = shutdownMiddlewareBackgroundTasks();
    expect(shutdown).toBeInstanceOf(Promise);
    expect(stopped).toBe(false);

    release();
    await shutdown;
    expect(stopped).toBe(true);
  });
});

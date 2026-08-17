import assert from 'node:assert/strict';

import type {
  RuntimeStateExpiryLifecycle,
  RuntimeStateExpiryStartupGeneration,
} from '../../src/services/runtime-state-expiry-startup.ts';
import {
  createApiV1BackgroundTaskLifecycle,
} from '../../src/composition/api-v1-background-task-lifecycle.ts';

Deno.test(
  'background lifecycle unregisters one stop and attempts every remaining stop',
  async () => {
    const calls: string[] = [];
    const lifecycle = createApiV1BackgroundTaskLifecycle({
      runtimeStateExpiry: createFakeRuntimeStateExpiryLifecycle(calls),
    });
    const unregister = lifecycle.register(() => {
      calls.push('removed');
    });
    lifecycle.register(() => {
      calls.push('first');
    });
    lifecycle.register(() => {
      calls.push('second');
      throw new Error('second failed');
    });
    lifecycle.register(() => {
      calls.push('third');
    });

    unregister();
    await assert.rejects(() => lifecycle.stop(), /second failed/);

    assert.deepEqual(calls, ['expiry-stop', 'first', 'second', 'third']);
  },
);

Deno.test('background lifecycle starts fresh generations and repeats one stop safely', async () => {
  const calls: string[] = [];
  const lifecycle = createApiV1BackgroundTaskLifecycle({
    runtimeStateExpiry: createFakeRuntimeStateExpiryLifecycle(calls),
  });

  const firstGeneration = lifecycle.beginStartupGeneration();
  const secondGeneration = lifecycle.beginStartupGeneration();
  assert.notEqual(firstGeneration, secondGeneration);

  lifecycle.register(() => {
    calls.push('task-stop');
  });
  await lifecycle.stop();
  await lifecycle.stop();

  assert.deepEqual(calls, ['begin', 'begin', 'expiry-stop', 'task-stop']);
});

function createFakeRuntimeStateExpiryLifecycle(
  calls: string[],
): RuntimeStateExpiryLifecycle {
  let stopped = false;

  return {
    beginStartupGeneration: () => {
      calls.push('begin');
      return createFakeStartupGeneration();
    },
    startRtcRttReceiptFamilyCleanup: () => Promise.resolve(0),
    stop: () => {
      if (stopped) {
        return;
      }

      stopped = true;
      calls.push('expiry-stop');
    },
  };
}

function createFakeStartupGeneration(): RuntimeStateExpiryStartupGeneration {
  return {
    isCurrent: () => true,
    startRtcRttReceiptFamilyCleanup: () => Promise.resolve(0),
    startRuntimeStateExpiryEviction: () => Promise.resolve(0),
  };
}

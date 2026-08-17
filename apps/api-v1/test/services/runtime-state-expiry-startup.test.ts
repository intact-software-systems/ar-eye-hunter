import assert from 'node:assert/strict';
import { runRuntimeStateExpiryStartupBarrier } from '../../src/services/runtime-state-expiry-startup.ts';

Deno.test('runtime-state expiry waits until all-scope topology generation backfill resolves', async () => {
  let resolveBackfill: ((result: Readonly<{ advanced: number }>) => void) | undefined;
  const backfill = new Promise<Readonly<{ advanced: number }>>((resolve) => {
    resolveBackfill = resolve;
  });
  const calls: string[] = [];
  const startup = runRuntimeStateExpiryStartupBarrier({
    backfillTopologyGenerations: () => {
      calls.push('backfill');
      return backfill;
    },
    initialiseRuntimeStateExpiryEviction: () => {
      calls.push('eviction');
      return Promise.resolve(0);
    },
    onGenerationsBackfilled: (advanced) => {
      calls.push(`advanced:${advanced}`);
    },
    initialiseRtcRttReceiptFamilyCleanup: () => {
      calls.push('rtc-family-cleanup');
      return Promise.resolve();
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['backfill']);

  resolveBackfill?.({ advanced: 2 });
  await startup;
  assert.deepEqual(calls, [
    'backfill',
    'advanced:2',
    'rtc-family-cleanup',
    'eviction',
  ]);
});

Deno.test('runtime-state expiry remains fail-closed when topology generation backfill fails', async () => {
  const failure = new Error('generation backfill failed');
  let rtcCleanupInitialisations = 0;
  let evictionInitialisations = 0;

  await assert.rejects(
    runRuntimeStateExpiryStartupBarrier({
      backfillTopologyGenerations: () => Promise.reject(failure),
      initialiseRuntimeStateExpiryEviction: () => {
        evictionInitialisations += 1;
        return Promise.resolve(0);
      },
      initialiseRtcRttReceiptFamilyCleanup: () => {
        rtcCleanupInitialisations += 1;
        return Promise.resolve();
      },
    }),
    failure,
  );
  assert.equal(rtcCleanupInitialisations, 0);
  assert.equal(evictionInitialisations, 0);
});

Deno.test('runtime-state expiry starts protected generic eviction when RTC family cleanup reports corruption', async () => {
  const failure = new Error('RTC family cleanup failed');
  let evictionInitialisations = 0;

  await assert.rejects(
    runRuntimeStateExpiryStartupBarrier({
      backfillTopologyGenerations: () => Promise.resolve({ advanced: 0 }),
      initialiseRtcRttReceiptFamilyCleanup: () => Promise.reject(failure),
      initialiseRuntimeStateExpiryEviction: () => {
        evictionInitialisations += 1;
        return Promise.resolve(0);
      },
    }),
    failure,
  );
  assert.equal(evictionInitialisations, 1);
});

Deno.test('runtime-state expiry surfaces specialized corruption while protected generic eviction remains long-running', async () => {
  const failure = new Error('RTC family cleanup is corrupt');
  let genericStarted = false;
  let settled: Readonly<{ status: 'rejected'; error: unknown }> | undefined;

  runRuntimeStateExpiryStartupBarrier({
    backfillTopologyGenerations: () => Promise.resolve({ advanced: 0 }),
    initialiseRtcRttReceiptFamilyCleanup: () => Promise.reject(failure),
    initialiseRuntimeStateExpiryEviction: () => {
      genericStarted = true;
      return new Promise<number>(() => {});
    },
  }).catch((error) => {
    settled = { status: 'rejected', error };
  });

  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

  assert.equal(genericStarted, true);
  assert.deepEqual(settled, { status: 'rejected', error: failure });
});

Deno.test('runtime-state expiry lifecycle retains, replaces, and stops rejected cleanup handles', async () => {
  const module = await import(
    '../../src/services/runtime-state-expiry-startup.ts'
  ) as unknown as Record<string, unknown>;
  const createLifecycle = module.createRuntimeStateExpiryLifecycle as
    | (() => {
      startRtcRttReceiptFamilyCleanup(
        initialise: () => Readonly<{ firstRun: Promise<number>; stop(): void }>,
      ): Promise<number>;
      stop(): void;
    })
    | undefined;
  assert.equal(typeof createLifecycle, 'function');
  const lifecycle = createLifecycle!();
  const firstFailure = new Error('corrupt family');
  let firstStops = 0;
  let secondStops = 0;

  await assert.rejects(
    lifecycle.startRtcRttReceiptFamilyCleanup(() => ({
      firstRun: Promise.reject(firstFailure),
      stop: () => firstStops += 1,
    })),
    firstFailure,
  );
  await lifecycle.startRtcRttReceiptFamilyCleanup(() => ({
    firstRun: Promise.resolve(0),
    stop: () => secondStops += 1,
  }));
  assert.equal(firstStops, 1);
  assert.equal(secondStops, 0);

  lifecycle.stop();
  lifecycle.stop();
  assert.equal(firstStops, 1);
  assert.equal(secondStops, 1);
});

Deno.test('runtime-state expiry lifecycle generation-fences delayed older startup handles', async () => {
  const module = await import(
    '../../src/services/runtime-state-expiry-startup.ts'
  ) as unknown as Record<string, unknown>;
  const createLifecycle = module.createRuntimeStateExpiryLifecycle as () => {
    beginStartupGeneration(): Readonly<{
      startRtcRttReceiptFamilyCleanup(
        initialise: () => Readonly<{ firstRun: Promise<number>; stop(): void }>,
      ): Promise<number>;
    }>;
    stop(): void;
  };
  const lifecycle = createLifecycle();
  const delayedOlder = lifecycle.beginStartupGeneration();
  const newest = lifecycle.beginStartupGeneration();
  let oldStops = 0;
  let newStops = 0;

  await delayedOlder.startRtcRttReceiptFamilyCleanup(() => ({
    firstRun: Promise.resolve(0),
    stop: () => oldStops += 1,
  }));
  await newest.startRtcRttReceiptFamilyCleanup(() => ({
    firstRun: Promise.resolve(0),
    stop: () => newStops += 1,
  }));

  assert.deepEqual({ oldStops, newStops }, { oldStops: 1, newStops: 0 });
  lifecycle.stop();
  lifecycle.stop();
  assert.deepEqual({ oldStops, newStops }, { oldStops: 1, newStops: 1 });
});

Deno.test('runtime-state expiry lifecycle generation-fences and owns generic eviction handles', async () => {
  const module = await import(
    '../../src/services/runtime-state-expiry-startup.ts'
  ) as unknown as Record<string, unknown>;
  const createLifecycle = module.createRuntimeStateExpiryLifecycle as () => {
    beginStartupGeneration(): Readonly<{
      startRuntimeStateExpiryEviction(
        initialise: () => Readonly<{ firstRun: Promise<number>; stop(): void }>,
      ): Promise<number>;
    }>;
    stop(): void;
  };
  const lifecycle = createLifecycle();
  const delayedOlder = lifecycle.beginStartupGeneration();
  const newest = lifecycle.beginStartupGeneration();
  let oldStops = 0;
  let newStops = 0;
  let replacementStops = 0;

  await delayedOlder.startRuntimeStateExpiryEviction(() => ({
    firstRun: Promise.resolve(0),
    stop: () => oldStops += 1,
  }));
  await newest.startRuntimeStateExpiryEviction(() => ({
    firstRun: Promise.resolve(0),
    stop: () => newStops += 1,
  }));
  assert.deepEqual({ oldStops, newStops }, { oldStops: 1, newStops: 0 });

  const replacement = lifecycle.beginStartupGeneration();
  assert.equal(newStops, 1);
  await replacement.startRuntimeStateExpiryEviction(() => ({
    firstRun: Promise.resolve(0),
    stop: () => replacementStops += 1,
  }));
  lifecycle.stop();
  lifecycle.stop();

  assert.deepEqual(
    { oldStops, newStops, replacementStops },
    { oldStops: 1, newStops: 1, replacementStops: 1 },
  );
});

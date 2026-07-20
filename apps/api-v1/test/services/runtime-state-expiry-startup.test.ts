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
      return Promise.resolve();
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
        return Promise.resolve();
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
        return Promise.resolve();
      },
    }),
    failure,
  );
  assert.equal(evictionInitialisations, 1);
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

Deno.test('api middleware protects RTC receipt families and starts specialized cleanup', async () => {
  const middlewareSource = await Deno.readTextFile(
    new URL('../../src/middleware.ts', import.meta.url),
  );

  assert.match(middlewareSource, /initRtcRttReceiptFamilyCleanup/);
  assert.match(middlewareSource, /RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES/);
  assert.match(
    middlewareSource,
    /excludedNamespaces:\s*RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES/,
  );
  assert.match(middlewareSource, /createRuntimeStateExpiryLifecycle/);
  assert.match(middlewareSource, /startRtcRttReceiptFamilyCleanup/);
  assert.match(middlewareSource, /shutdownMiddlewareBackgroundTasks/);

  const mainSource = await Deno.readTextFile(
    new URL('../../src/main.ts', import.meta.url),
  );
  assert.match(mainSource, /shutdownMiddlewareBackgroundTasks/);
  assert.match(mainSource, /addEventListener\(['"]unload['"]/);
});

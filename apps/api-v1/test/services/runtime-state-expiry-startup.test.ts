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
    initialiseRuntimeStateExpiryEviction: async () => {
      calls.push('eviction');
    },
    onGenerationsBackfilled: (advanced) => {
      calls.push(`advanced:${advanced}`);
    },
    initialiseRtcRttReceiptFamilyCleanup: async () => {
      calls.push('rtc-family-cleanup');
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
      initialiseRuntimeStateExpiryEviction: async () => {
        evictionInitialisations += 1;
      },
      initialiseRtcRttReceiptFamilyCleanup: async () => {
        rtcCleanupInitialisations += 1;
      },
    }),
    failure,
  );
  assert.equal(rtcCleanupInitialisations, 0);
  assert.equal(evictionInitialisations, 0);
});

Deno.test('runtime-state expiry does not start generic eviction when RTC family cleanup startup fails', async () => {
  const failure = new Error('RTC family cleanup failed');
  let evictionInitialisations = 0;

  await assert.rejects(
    runRuntimeStateExpiryStartupBarrier({
      backfillTopologyGenerations: () => Promise.resolve({ advanced: 0 }),
      initialiseRtcRttReceiptFamilyCleanup: () => Promise.reject(failure),
      initialiseRuntimeStateExpiryEviction: async () => {
        evictionInitialisations += 1;
      },
    }),
    failure,
  );
  assert.equal(evictionInitialisations, 0);
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
});

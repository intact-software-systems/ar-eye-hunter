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
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['backfill']);

  resolveBackfill?.({ advanced: 2 });
  await startup;
  assert.deepEqual(calls, ['backfill', 'advanced:2', 'eviction']);
});

Deno.test('runtime-state expiry remains fail-closed when topology generation backfill fails', async () => {
  const failure = new Error('generation backfill failed');
  let evictionInitialisations = 0;

  await assert.rejects(
    runRuntimeStateExpiryStartupBarrier({
      backfillTopologyGenerations: () => Promise.reject(failure),
      initialiseRuntimeStateExpiryEviction: async () => {
        evictionInitialisations += 1;
      },
    }),
    failure,
  );
  assert.equal(evictionInitialisations, 0);
});

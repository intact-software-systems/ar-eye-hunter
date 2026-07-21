import { describe, expect, it, vi } from 'vitest';
import {
  createInProcessMutationLane,
  IN_PROCESS_MUTATION_HANDOFF_MS,
  waitForInProcessMutationHandoff,
} from '@shared-server/rallar-system/services/in-process-mutation-lane.ts';
import {
  DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
  waitForRuntimeStateWriteRetry,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

describe('in-process mutation lane', () => {
  it('uses a dedicated three millisecond best-effort handoff timer', async () => {
    vi.useFakeTimers();
    let settled = false;
    try {
      const handoff = waitForInProcessMutationHandoff().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(IN_PROCESS_MUTATION_HANDOFF_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await handoff;
      expect(settled).toBe(true);
      expect(IN_PROCESS_MUTATION_HANDOFF_MS).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs same-key effects in FIFO order without overlap', async () => {
    const lane = createInProcessMutationLane();
    const firstRelease = deferred<void>();
    const events: string[] = [];

    const first = lane.run('group-a', async () => {
      events.push('first:start');
      await firstRelease.promise;
      events.push('first:end');
    });
    const second = lane.run('group-a', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await settleMicrotasks();
    expect(events).toEqual(['first:start']);
    expect(lane.pendingKeyCount()).toBe(1);

    firstRelease.resolve();
    await Promise.all([first, second]);
    await settleMicrotasks();

    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
    expect(lane.pendingKeyCount()).toBe(0);
  });

  it('keeps distinct keys concurrent', async () => {
    const lane = createInProcessMutationLane();
    const release = deferred<void>();
    const started: string[] = [];

    const first = lane.run('group-a', async () => {
      started.push('group-a');
      await release.promise;
    });
    const second = lane.run('group-b', async () => {
      started.push('group-b');
      await release.promise;
    });

    await settleMicrotasks();
    expect(started).toEqual(['group-a', 'group-b']);
    expect(lane.pendingKeyCount()).toBe(2);

    release.resolve();
    await Promise.all([first, second]);
    await settleMicrotasks();
    expect(lane.pendingKeyCount()).toBe(0);
  });

  it('continues after rejection and cleans the completed key', async () => {
    const lane = createInProcessMutationLane();
    const events: string[] = [];

    const rejected = lane.run('group-a', () => {
      events.push('rejected');
      return Promise.reject(new Error('expected failure'));
    });
    const recovered = lane.run('group-a', async () => {
      events.push('recovered');
      return 'accepted';
    });

    await expect(rejected).rejects.toThrow('expected failure');
    await expect(recovered).resolves.toBe('accepted');
    await settleMicrotasks();
    expect(events).toEqual(['rejected', 'recovered']);
    expect(lane.pendingKeyCount()).toBe(0);
  });

  it('normalizes queued aborts, skips their effects, and runs successors', async () => {
    const lane = createInProcessMutationLane();
    const firstRelease = deferred<void>();
    const controller = new AbortController();
    let abortedEffectRan = false;
    let successorRan = false;

    const first = lane.run('group-a', async () => {
      await firstRelease.promise;
    });
    const aborted = lane.run(
      'group-a',
      async () => {
        abortedEffectRan = true;
      },
      { signal: controller.signal },
    );
    void aborted.catch(() => undefined);
    const successor = lane.run('group-a', async () => {
      successorRan = true;
    });
    controller.abort(new Error('custom abort reason'));

    firstRelease.resolve();
    await first;
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    await successor;
    await settleMicrotasks();
    expect(abortedEffectRan).toBe(false);
    expect(successorRan).toBe(true);
    expect(lane.pendingKeyCount()).toBe(0);
  });

  it('hands a key to an already-scheduled remote retry before its local successor', async () => {
    const events: string[] = [];
    const scheduler = createVirtualDelayScheduler((tag, delayMs) => {
      events.push(`delay:${tag}:${delayMs}`);
    });
    let activeTransactions = 0;
    let revision = 0;
    const retrySleeps: number[] = [];
    const remoteInitialRead = deferred<void>();
    const winnerTransactionEnded = deferred<void>();
    const winnerMayReturn = deferred<void>();
    const laneA = createInProcessMutationLane({
      postSuccessHandoff: () => {
        expect(activeTransactions).toBe(0);
        return scheduler.sleep('handoff:a', 2);
      },
    });
    const laneB = createInProcessMutationLane({
      postSuccessHandoff: () => {
        expect(activeTransactions).toBe(0);
        return scheduler.sleep('handoff:b', 2);
      },
    });

    const mutate = async (actor: 'winner' | 'remote' | 'successor') => {
      for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
        await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
          sleep: (delayMs) => {
            retrySleeps.push(delayMs);
            expect(activeTransactions).toBe(0);
            return scheduler.sleep(`retry:${actor}:${attempt}`, delayMs);
          },
        });
        const expectedRevision = revision;
        events.push(`${actor}:read:${expectedRevision}`);
        events.push(`${actor}:validate:${expectedRevision}`);

        if (actor === 'winner' && attempt === 0) {
          await remoteInitialRead.promise;
        } else if (actor === 'remote' && attempt === 0) {
          remoteInitialRead.resolve();
          await winnerTransactionEnded.promise;
        }

        events.push(`${actor}:transaction:start`);
        activeTransactions += 1;
        if (revision !== expectedRevision) {
          activeTransactions -= 1;
          events.push(`${actor}:transaction:conflict`);
          continue;
        }
        revision += 1;
        activeTransactions -= 1;
        events.push(`${actor}:transaction:end:${revision}`);
        if (actor === 'winner') {
          winnerTransactionEnded.resolve();
          await winnerMayReturn.promise;
          events.push('winner:effect:return');
        }
        return revision;
      }
      throw new Error(`${actor} exhausted its fake CAS attempts`);
    };

    const winner = laneA.run('group-a', () => mutate('winner'));
    const successor = laneA.run('group-a', () => mutate('successor'));
    const remote = laneB.run('group-a', () => mutate('remote'));
    try {
      await scheduler.scheduled('retry:remote:1');
      winnerMayReturn.resolve();
      await settleMicrotasks();

      expect(scheduler.pending()).toContainEqual({ tag: 'handoff:a', delayMs: 2 });
      expect(events.indexOf('winner:transaction:end:1'))
        .toBeLessThan(events.indexOf('delay:handoff:a:2'));
      expect(activeTransactions).toBe(0);

      const distinct = laneA.run('group-b', async () => {
        events.push('distinct:effect');
      });
      const presence = Promise.resolve().then(() => {
        events.push('presence:bypass');
      });
      await Promise.all([distinct, presence]);
      expect(events).toContain('distinct:effect');
      expect(events).toContain('presence:bypass');
      expect(events.some((event) => event.startsWith('successor:read:'))).toBe(false);

      scheduler.advanceBy(2);
      await Promise.all([winner, successor, remote]);

      expect(retrySleeps).toEqual([2]);
      expect(events.filter((event) => event.startsWith('remote:read:'))).toEqual([
        'remote:read:0',
        'remote:read:1',
      ]);
      expect(events.filter((event) => event.startsWith('remote:validate:'))).toEqual([
        'remote:validate:0',
        'remote:validate:1',
      ]);
      expect(events.indexOf('remote:transaction:end:2'))
        .toBeLessThan(events.indexOf('successor:transaction:end:3'));
      expect(scheduler.pending()).toEqual([]);
    } finally {
      winnerMayReturn.resolve();
      scheduler.releaseAll();
      await Promise.allSettled([winner, successor, remote]);
    }
  });

  it('does not turn a completed effect into failure when its handoff rejects', async () => {
    const handoff = vi.fn(() => Promise.reject(new Error('handoff unavailable')));
    const lane = createInProcessMutationLane({ postSuccessHandoff: handoff });
    const first = lane.run('group-a', async () => 'committed');
    const successor = lane.run('group-a', async () => 'successor');

    await expect(first).resolves.toBe('committed');
    await expect(successor).resolves.toBe('successor');
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it('skips handoff without an eligible successful same-key successor', async () => {
    const handoff = vi.fn(() => Promise.resolve());
    const lane = createInProcessMutationLane({ postSuccessHandoff: handoff });

    await lane.run('lone', async () => 'lone');
    await Promise.all([
      lane.run('distinct-a', async () => 'a'),
      lane.run('distinct-b', async () => 'b'),
    ]);

    const rejected = lane.run('rejected', async () => {
      throw new Error('expected rejection');
    });
    const afterRejection = lane.run('rejected', async () => 'recovered');
    await expect(rejected).rejects.toThrow('expected rejection');
    await expect(afterRejection).resolves.toBe('recovered');

    const controller = new AbortController();
    controller.abort();
    await expect(lane.run('aborted', async () => 'unexpected', {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    for (const source of ['claim', 'replay', 'no-op', 'rejected'] as const) {
      const ineligible = lane.run(
        `predicate:${source}`,
        async () => ({ source }),
        { shouldHandoff: (result) => result.source === 'write' },
      );
      const successor = lane.run(
        `predicate:${source}`,
        async () => ({ source: 'write' as const }),
      );
      await Promise.all([ineligible, successor]);
    }

    expect(handoff).not.toHaveBeenCalled();
  });

  it.each(
    [
      {
        handoffDelayMs: 2,
        expectedOrder: ['successor:start', 'remote:retry'],
      },
      {
        handoffDelayMs: 3,
        expectedOrder: ['remote:retry', 'successor:start'],
      },
    ] as const,
  )(
    'characterizes a $handoffDelayMs ms handoff with 0.5 ms conflict-observation lag',
    async ({ handoffDelayMs, expectedOrder }) => {
      const events: string[] = [];
      const scheduler = createVirtualDelayScheduler((tag, delayMs) => {
        events.push(`delay:${tag}:${delayMs}`);
      });
      const lane = createInProcessMutationLane({
        postSuccessHandoff: () => scheduler.sleep('handoff', handoffDelayMs),
      });
      const winner = lane.run('group-a', async () => {
        events.push('winner:transaction:end');
      });
      const successor = lane.run('group-a', async () => {
        events.push('successor:start');
      });
      let remote: Promise<void> | undefined;

      try {
        await scheduler.scheduled('handoff');
        remote = (async () => {
          await scheduler.sleep('conflict-observation', 0.5);
          events.push('remote:conflict');
          await scheduler.sleep('remote-retry', 2);
          events.push('remote:retry');
        })();

        scheduler.advanceBy(0.5);
        await settleMicrotasks();
        expect(scheduler.pending()).toContainEqual({ tag: 'remote-retry', delayMs: 2 });

        scheduler.advanceBy(1.5);
        await settleMicrotasks();
        scheduler.advanceBy(0.5);
        await settleMicrotasks();
        scheduler.advanceBy(0.5);
        await Promise.all([winner, successor, remote]);

        expect(events.filter((event) => event === 'remote:retry' || event === 'successor:start'))
          .toEqual(expectedOrder);
      } finally {
        scheduler.releaseAll();
        await Promise.allSettled([winner, successor, ...(remote ? [remote] : [])]);
      }
    },
  );
});

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createVirtualDelayScheduler(
  onScheduled: (tag: string, delayMs: number) => void,
): Readonly<{
  sleep(tag: string, delayMs: number): Promise<void>;
  scheduled(tag: string): Promise<void>;
  pending(): readonly Readonly<{ tag: string; delayMs: number }>[];
  advanceBy(delayMs: number): void;
  releaseAll(): void;
}> {
  const delays: Array<
    Readonly<{
      tag: string;
      delayMs: number;
      dueAtMs: number;
      ordinal: number;
      resolve(): void;
    }>
  > = [];
  const waiters = new Map<string, Array<() => void>>();
  let nowMs = 0;
  let nextOrdinal = 0;
  return {
    sleep: (tag, delayMs) =>
      new Promise<void>((resolve) => {
        delays.push({
          tag,
          delayMs,
          dueAtMs: nowMs + delayMs,
          ordinal: nextOrdinal,
          resolve,
        });
        nextOrdinal += 1;
        onScheduled(tag, delayMs);
        for (const notify of waiters.get(tag) ?? []) notify();
        waiters.delete(tag);
      }),
    scheduled: (tag) => {
      if (delays.some((delay) => delay.tag === tag)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.set(tag, [...(waiters.get(tag) ?? []), resolve]);
      });
    },
    pending: () => delays.map(({ tag, delayMs }) => ({ tag, delayMs })),
    advanceBy: (delayMs) => {
      nowMs += delayMs;
      const ready = delays
        .filter((delay) => delay.dueAtMs <= nowMs)
        .sort((left, right) => left.dueAtMs - right.dueAtMs || left.ordinal - right.ordinal);
      for (const delay of ready) {
        delays.splice(delays.indexOf(delay), 1);
        delay.resolve();
      }
    },
    releaseAll: () => {
      for (const delay of delays.splice(0)) delay.resolve();
    },
  };
}

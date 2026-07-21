import { describe, expect, it } from 'vitest';
import { createInProcessMutationLane } from '@shared-server/rallar-system/services/in-process-mutation-lane.ts';

describe('in-process mutation lane', () => {
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

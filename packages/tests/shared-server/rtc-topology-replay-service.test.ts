import { describe, expect, it, vi } from 'vitest';

import type { RtcTopologyDeliveryLogEntry } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-contracts.ts';
import { RtcTopologyDeliveryLeaseLostError } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-stream-service.ts';
import { RtcTopologyDeliveryCorruptionError } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-validation.ts';
import type {
  RtcTopologyReplayCursorCasInput,
  RtcTopologyReplayCursorSnapshot,
  RtcTopologyReplayPageInput,
  RtcTopologyReplayPageResult,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-contracts.ts';
import {
  type RtcTopologyReplayEntryHandler,
  type RtcTopologyReplayPort,
  RtcTopologyReplayService,
  type RtcTopologyReplayServiceScheduler,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-service.ts';
import type {
  RtcTopologyReplayDiagnosticsEvent,
  RtcTopologyReplayDiagnosticsSink,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-diagnostics.ts';

const CONSUMER = '00000000-0000-4000-8000-000000000001';
const PUBLISHER_A = '00000000-0000-4000-8000-000000000002';
const PUBLISHER_B = '00000000-0000-4000-8000-000000000003';

describe('RtcTopologyReplayService', () => {
  it('keeps duplicate notification and local-commit wakes single-flight', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const send = deferredEntryHandling();
    const service = replayService(repository, { handler: send.handler });
    await service.start();
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 1));

    service.wake('notification');
    await send.started;
    service.wake('notification');
    service.wake('local-commit');
    send.complete({ status: 'delivered' });
    await service.whenIdle();

    expect(send.maximumConcurrency()).toBe(1);
    expect(send.handledSequences()).toEqual([1]);
    expect(repository.cursor(PUBLISHER_A)).toBe(1);
    await service.stop();
  });

  it('holds early wakeups behind atomic startup cursor initialization', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const initialization = deferred<void>();
    const originalInitialize = repository.initializeConsumer.bind(repository);
    vi.spyOn(repository, 'initializeConsumer').mockImplementation(async () => {
      await initialization.promise;
      return await originalInitialize();
    });
    const discover = vi.spyOn(repository, 'discoverPublishers');
    const service = replayService(repository);

    const readiness = service.start();
    service.wake('notification');
    await Promise.resolve();
    expect(discover).not.toHaveBeenCalled();

    initialization.resolve();
    await readiness;
    await service.whenIdle();
    expect(discover).toHaveBeenCalled();
    await service.stop();
  });

  it('rotates publishers fairly and yields after ten pages or one thousand entries', async () => {
    const repository = new FakeReplayRepository({
      [PUBLISHER_A]: [],
      [PUBLISHER_B]: [],
    });
    const scheduler = fakeScheduler();
    const service = replayService(repository, { scheduler });
    await service.start();
    repository.pagePublishers.length = 0;
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 600));
    repository.publish(PUBLISHER_B, entries(PUBLISHER_B, 600));

    service.wake('poll');
    await service.whenIdle();

    expect(repository.pagePublishers.slice(0, 10)).toEqual([
      PUBLISHER_A,
      PUBLISHER_B,
      PUBLISHER_A,
      PUBLISHER_B,
      PUBLISHER_A,
      PUBLISHER_B,
      PUBLISHER_A,
      PUBLISHER_B,
      PUBLISHER_A,
      PUBLISHER_B,
    ]);
    expect(scheduler.yieldCount()).toBe(1);
    expect(repository.cursor(PUBLISHER_A)).toBe(600);
    expect(repository.cursor(PUBLISHER_B)).toBe(600);
    await service.stop();
  });

  it('advances only through the contiguous predecessor of a send failure', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const service = replayService(repository, {
      handler: {
        handle: async (entry) =>
          entry.sequence === 2 ? { status: 'send-failed' } : { status: 'delivered' },
      },
    });
    await service.start();
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 3));

    service.wake('notification');
    await service.whenIdle();

    expect(repository.cursor(PUBLISHER_A)).toBe(1);
    await service.stop();
  });

  it('retries from the durable cursor after a compare-and-set conflict', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const handledSequences: number[] = [];
    const service = replayService(repository, {
      handler: {
        handle: async (entry) => {
          handledSequences.push(entry.sequence);
          return { status: 'delivered' };
        },
      },
    });
    await service.start();
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 1));
    repository.cursorCasConflictsRemaining = 1;

    service.wake('notification');
    await service.whenIdle();
    expect(repository.cursor(PUBLISHER_A)).toBe(0);

    service.wake('poll');
    await service.whenIdle();
    expect(handledSequences).toEqual([1, 1]);
    expect(repository.cursor(PUBLISHER_A)).toBe(1);
    await service.stop();
  });

  it('stalls the corrupt entry without advancing its durable cursor', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const service = replayService(repository, {
      handler: {
        handle: async () => {
          throw new RtcTopologyDeliveryCorruptionError('corrupt durable reference');
        },
      },
    });
    await service.start();
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 1));

    service.wake('poll');
    await service.whenIdle();

    expect(repository.cursor(PUBLISHER_A)).toBe(0);
    await service.stop();
  });

  it('acknowledges no-local-recipient as successful replay', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const service = replayService(repository, {
      handler: { handle: async () => ({ status: 'no-local-recipient' }) },
    });
    await service.start();
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 1));

    service.wake('notification');
    await service.whenIdle();

    expect(repository.cursor(PUBLISHER_A)).toBe(1);
    await service.stop();
  });

  it('hydrates every captured local connection before advancing a retention gap to HEAD', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const hydrateGap = vi.fn(async () => undefined);
    const service = replayService(repository, { hydrateGap });
    await service.start();
    repository.setGap(PUBLISHER_A, { cursorSequence: 0, retainedFromSequence: 4, headSequence: 5 });

    service.wake('poll');
    await service.whenIdle();

    expect(hydrateGap).toHaveBeenCalledTimes(1);
    expect(repository.cursor(PUBLISHER_A)).toBe(5);
    await service.stop();
  });

  it('leaves a retention-gap cursor unchanged when current-state hydration fails', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const hydrateGap = vi.fn(async () => {
      throw new Error('captured connection hydration failed');
    });
    const service = replayService(repository, { hydrateGap });
    await service.start();
    repository.setGap(PUBLISHER_A, { cursorSequence: 0, retainedFromSequence: 4, headSequence: 5 });

    service.wake('poll');
    await service.whenIdle();

    expect(hydrateGap).toHaveBeenCalledTimes(1);
    expect(repository.cursor(PUBLISHER_A)).toBe(0);
    await service.stop();
  });

  it('stops polling and reports typed lease loss', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const scheduler = fakeScheduler();
    const onHealthFailure = vi.fn();
    const service = replayService(repository, { scheduler, onHealthFailure });
    await service.start();
    repository.captureFailure = new RtcTopologyDeliveryLeaseLostError('consumer lease lost');

    service.wake('poll');
    await service.whenIdle();

    expect(onHealthFailure).toHaveBeenCalledWith(repository.captureFailure);
    expect(scheduler.cancelled()).toBe(true);
  });

  it('aborts and drains in-flight entry handling before shutdown completes', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const scheduler = fakeScheduler();
    const handlingStarted = deferred<void>();
    let handlingObservedAbort = false;
    const service = replayService(repository, {
      scheduler,
      handler: {
        handle: async (_entry, _databaseNowEpochMs, signal) => {
          handlingStarted.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                handlingObservedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          return { status: 'send-failed' };
        },
      },
    });
    await service.start();
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 1));
    service.wake('notification');
    await handlingStarted.promise;

    await service.stop();

    expect(handlingObservedAbort).toBe(true);
    expect(scheduler.cancelled()).toBe(true);
    expect(repository.cursor(PUBLISHER_A)).toBe(0);
    service.wake('poll');
    await service.whenIdle();
    expect(repository.cursor(PUBLISHER_A)).toBe(0);
  });

  it('reports bounded wake, drain, entry, and cursor outcomes without identifiers', async () => {
    const repository = new FakeReplayRepository({ [PUBLISHER_A]: [] });
    const events: RtcTopologyReplayDiagnosticsEvent[] = [];
    const service = replayService(repository, {
      diagnostics: (event) => events.push(event),
    });
    await service.start();
    repository.publish(PUBLISHER_A, entries(PUBLISHER_A, 1));

    service.wake('local-commit');
    await service.whenIdle();

    expect(events).toContainEqual({ kind: 'wake', source: 'startup' });
    expect(events).toContainEqual({ kind: 'wake', source: 'local-commit' });
    expect(events).toContainEqual({ kind: 'entry', outcome: 'delivered' });
    expect(events).toContainEqual({ kind: 'cursor', outcome: 'advanced' });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'drain',
        outcome: 'caught-up',
        entryCount: 1,
        maxLagEntries: 1,
      }),
    );
    expect(JSON.stringify(events)).not.toContain(CONSUMER);
    expect(JSON.stringify(events)).not.toContain(PUBLISHER_A);
    await service.stop();
  });
});

function replayService(
  repository: FakeReplayRepository,
  options: Readonly<{
    handler?: RtcTopologyReplayEntryHandler;
    hydrateGap?: (signal: AbortSignal) => Promise<void>;
    scheduler?: RtcTopologyReplayServiceScheduler;
    onHealthFailure?: (error: Error) => void;
    diagnostics?: RtcTopologyReplayDiagnosticsSink;
  }> = {},
) {
  return new RtcTopologyReplayService({
    consumerStreamId: CONSUMER,
    repository,
    entryHandler: options.handler ?? { handle: async () => ({ status: 'delivered' }) },
    hydrateGap: options.hydrateGap ?? (async () => undefined),
    scheduler: options.scheduler,
    onHealthFailure: options.onHealthFailure ?? (() => undefined),
    diagnostics: options.diagnostics,
  });
}

class FakeReplayRepository implements RtcTopologyReplayPort {
  readonly pagePublishers: string[] = [];
  captureFailure: Error | undefined;
  cursorCasConflictsRemaining = 0;
  readonly #entries = new Map<string, readonly RtcTopologyDeliveryLogEntry[]>();
  readonly #cursors = new Map<string, number>();
  readonly #gaps = new Map<
    string,
    Readonly<{ cursorSequence: number; retainedFromSequence: number; headSequence: number }>
  >();

  constructor(
    entriesByPublisher: Readonly<Record<string, readonly RtcTopologyDeliveryLogEntry[]>>,
  ) {
    this.#entries.set(CONSUMER, []);
    this.#cursors.set(CONSUMER, 0);
    for (const [publisherStreamId, publisherEntries] of Object.entries(entriesByPublisher)) {
      this.#entries.set(publisherStreamId, publisherEntries);
      this.#cursors.set(publisherStreamId, 0);
    }
  }

  initializeConsumer(): Promise<readonly RtcTopologyReplayCursorSnapshot[]> {
    return Promise.resolve(this.snapshots());
  }

  discoverPublishers(): Promise<readonly RtcTopologyReplayCursorSnapshot[]> {
    return Promise.resolve(this.snapshots());
  }

  capturePage(input: RtcTopologyReplayPageInput): Promise<RtcTopologyReplayPageResult> {
    if (this.captureFailure) return Promise.reject(this.captureFailure);
    const gap = this.#gaps.get(input.publisherStreamId);
    if (gap) {
      this.pagePublishers.push(input.publisherStreamId);
      return Promise.resolve({
        status: 'gap',
        cursorSequence: gap.cursorSequence,
        retainedFromSequence: gap.retainedFromSequence,
        capturedHeadSequence: gap.headSequence,
        databaseNowEpochMs: 1_000,
      });
    }
    const cursor = this.cursor(input.publisherStreamId);
    const publisherEntries = this.#entries.get(input.publisherStreamId) ?? [];
    const headSequence = publisherEntries.length;
    if (cursor === headSequence) {
      return Promise.resolve({
        status: 'caught-up',
        cursorSequence: cursor,
        retainedFromSequence: 1,
        capturedHeadSequence: headSequence,
        databaseNowEpochMs: 1_000,
      });
    }
    this.pagePublishers.push(input.publisherStreamId);
    const page = publisherEntries.slice(cursor, cursor + input.pageSize);
    return Promise.resolve({
      status: 'page',
      expectedCursorSequence: cursor,
      retainedFromSequence: 1,
      capturedHeadSequence: headSequence,
      databaseNowEpochMs: 1_000,
      entries: page,
      hasMore: page.at(-1)!.sequence < headSequence,
    });
  }

  compareAndSetCursor(input: RtcTopologyReplayCursorCasInput) {
    const currentSequence = this.#cursors.get(input.publisherStreamId);
    if (currentSequence === undefined) return Promise.resolve({ status: 'missing' } as const);
    if (this.cursorCasConflictsRemaining > 0) {
      this.cursorCasConflictsRemaining -= 1;
      return Promise.resolve({ status: 'conflict', currentSequence } as const);
    }
    if (currentSequence !== input.expectedSequence) {
      return Promise.resolve({ status: 'conflict', currentSequence } as const);
    }
    this.#cursors.set(input.publisherStreamId, input.nextSequence);
    const gap = this.#gaps.get(input.publisherStreamId);
    if (gap && input.nextSequence === gap.headSequence) this.#gaps.delete(input.publisherStreamId);
    return Promise.resolve({ status: 'advanced' } as const);
  }

  cursor(publisherStreamId: string): number {
    const cursor = this.#cursors.get(publisherStreamId);
    if (cursor === undefined) throw new Error(`Missing fake cursor ${publisherStreamId}`);
    return cursor;
  }

  setGap(
    publisherStreamId: string,
    gap: Readonly<{ cursorSequence: number; retainedFromSequence: number; headSequence: number }>,
  ) {
    this.#gaps.set(publisherStreamId, gap);
    this.#cursors.set(publisherStreamId, gap.cursorSequence);
  }

  publish(publisherStreamId: string, publisherEntries: readonly RtcTopologyDeliveryLogEntry[]) {
    this.#entries.set(publisherStreamId, publisherEntries);
  }

  private snapshots(): readonly RtcTopologyReplayCursorSnapshot[] {
    return [...this.#entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([publisherStreamId, publisherEntries]) => ({
        consumerStreamId: CONSUMER,
        publisherStreamId,
        headSequence: this.#gaps.get(publisherStreamId)?.headSequence ?? publisherEntries.length,
        retainedFromSequence: this.#gaps.get(publisherStreamId)?.retainedFromSequence ?? 1,
        lastProcessedSequence: this.cursor(publisherStreamId),
        cursorUpdatedAtEpochMs: 1_000,
        publisherLeaseExpiresAtEpochMs: 31_000,
      }));
  }
}

function entries(publisherStreamId: string, count: number): readonly RtcTopologyDeliveryLogEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    publisherStreamId,
    sequence: index + 1,
    groupRef: {
      applicationId: 'replay-app',
      workspaceId: 'replay-workspace',
      groupId: `group-${index + 1}`,
    },
    publicationId: `publication-${index + 1}`,
    outboxKey: {
      topicId: 'app-outbox.rtc-topology',
      resourceId: `resource-${index + 1}`,
      contextId: `context-${index + 1}`,
    },
    retainUntilEpochMs: 86_401_000,
    insertedAtEpochMs: 1_000,
  }));
}

function fakeScheduler(): RtcTopologyReplayServiceScheduler & {
  yieldCount(): number;
  cancelled(): boolean;
} {
  let yields = 0;
  let isCancelled = false;
  return {
    repeat: () => () => {
      isCancelled = true;
    },
    yield: async () => {
      yields += 1;
    },
    yieldCount: () => yields,
    cancelled: () => isCancelled,
  };
}

function deferredEntryHandling() {
  let complete: (
    result: Awaited<ReturnType<RtcTopologyReplayEntryHandler['handle']>>,
  ) => void = () => undefined;
  let start: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const result = new Promise<Awaited<ReturnType<RtcTopologyReplayEntryHandler['handle']>>>(
    (resolve) => {
      complete = resolve;
    },
  );
  let concurrency = 0;
  let maximumConcurrency = 0;
  const handledSequences: number[] = [];
  return {
    handler: {
      handle: async (entry: RtcTopologyDeliveryLogEntry) => {
        concurrency += 1;
        maximumConcurrency = Math.max(maximumConcurrency, concurrency);
        handledSequences.push(entry.sequence);
        start();
        const handled = await result;
        concurrency -= 1;
        return handled;
      },
    },
    started,
    complete,
    maximumConcurrency: () => maximumConcurrency,
    handledSequences: () => handledSequences,
  };
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

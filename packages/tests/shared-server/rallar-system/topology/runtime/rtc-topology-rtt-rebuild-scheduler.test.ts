import { describe, expect, it } from 'vitest';

import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts';
import { RtcTopologyRttRebuildScheduler } from '@shared-server/rallar-system/topology/runtime/rtc-topology-rtt-rebuild-scheduler.ts';

describe('RtcTopologyRttRebuildScheduler', () => {
  it('makes work without a snapshot immediately due', () => {
    const clock = createMutableClock(100);
    const metrics = new RtcTopologyMetrics();
    const scheduler = createScheduler(clock, metrics);

    expect(scheduler.queue({ overlayId: 'overlay-1', hasSnapshot: false })).toEqual({
      overlayId: 'overlay-1',
      dueAtEpochMs: 100,
      delayMs: 0,
      newlyQueued: true,
      immediate: true,
    });
    expect(scheduler.claimDue('overlay-1')).toBe(true);
    expect(metrics.read(0, scheduler.size)).toMatchObject({
      rttQueueRequestCount: 0,
      rttQueueNewCount: 1,
      rttQueueCoalescedCount: 0,
      rttQueueImmediateCount: 1,
      rttFlushAttemptCount: 0,
      rttFlushSkippedCount: 0,
      rttFlushExecutedCount: 1,
    });
  });

  it('debounces snapshot-backed work and coalesces on the first deadline', () => {
    const clock = createMutableClock(100);
    const metrics = new RtcTopologyMetrics();
    const scheduler = createScheduler(clock, metrics);

    const first = scheduler.queue({ overlayId: 'overlay-1', hasSnapshot: true });
    clock.now = 125;
    const second = scheduler.queue({ overlayId: 'overlay-1', hasSnapshot: true });

    expect(first).toEqual({
      overlayId: 'overlay-1',
      dueAtEpochMs: 150,
      delayMs: 50,
      newlyQueued: true,
      immediate: false,
    });
    expect(second).toEqual({
      overlayId: 'overlay-1',
      dueAtEpochMs: 150,
      delayMs: 25,
      newlyQueued: false,
      immediate: false,
    });
    expect(scheduler.readDelayMs('overlay-1')).toBe(25);
    expect(scheduler.readDebounceMs()).toBe(50);
    expect(metrics.read(0, scheduler.size)).toMatchObject({
      rttQueueRequestCount: 0,
      rttQueueNewCount: 1,
      rttQueueCoalescedCount: 1,
      rttQueueImmediateCount: 0,
    });
  });

  it('skips absent and early claims, executes one due claim, then skips the second claim', () => {
    const clock = createMutableClock(100);
    const metrics = new RtcTopologyMetrics();
    const scheduler = createScheduler(clock, metrics);

    expect(scheduler.claimDue('absent')).toBe(false);
    scheduler.queue({ overlayId: 'overlay-1', hasSnapshot: true });
    expect(scheduler.claimDue('overlay-1')).toBe(false);
    clock.now = 150;
    expect(scheduler.claimDue('overlay-1')).toBe(true);
    expect(scheduler.claimDue('overlay-1')).toBe(false);
    expect(metrics.read(0, scheduler.size)).toMatchObject({
      rttFlushAttemptCount: 0,
      rttFlushSkippedCount: 3,
      rttFlushExecutedCount: 1,
    });
  });

  it('removes pending work while leaving public request attempts to the facade', () => {
    const clock = createMutableClock(100);
    const metrics = new RtcTopologyMetrics();
    const scheduler = createScheduler(clock, metrics);

    scheduler.queue({ overlayId: 'overlay-1', hasSnapshot: true });
    expect(scheduler.remove('overlay-1')).toBe(true);
    expect(scheduler.remove('overlay-1')).toBe(false);
    expect(scheduler.size).toBe(0);

    let shouldThrow = false;
    const throwingScheduler = new RtcTopologyRttRebuildScheduler({
      nowEpochMs: () => {
        if (shouldThrow) {
          throw new Error('clock unavailable');
        }
        return 100;
      },
      debounceMs: 50,
      metrics,
    });

    throwingScheduler.queue({ overlayId: 'overlay-2', hasSnapshot: false });
    shouldThrow = true;
    expect(() => throwingScheduler.claimDue('overlay-2')).toThrow('clock unavailable');

    const unavailableClockScheduler = new RtcTopologyRttRebuildScheduler({
      nowEpochMs: () => {
        throw new Error('clock unavailable');
      },
      debounceMs: 50,
      metrics,
    });
    expect(() => unavailableClockScheduler.queue({ overlayId: 'overlay-3', hasSnapshot: false })).toThrow('clock unavailable');
    expect(metrics.read(0, scheduler.size)).toMatchObject({
      rttQueueRequestCount: 0,
      rttFlushAttemptCount: 0,
    });
  });
});

interface MutableClock {
  now: number;
}

function createMutableClock(now: number): MutableClock {
  return { now };
}

function createScheduler(clock: MutableClock, metrics: RtcTopologyMetrics): RtcTopologyRttRebuildScheduler {
  return new RtcTopologyRttRebuildScheduler({
    nowEpochMs: () => clock.now,
    debounceMs: 50,
    metrics,
  });
}

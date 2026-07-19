import { describe, expect, it } from 'vitest';
import { analyzeRtcOutboundRuntimeEvents } from '../../../scripts/perf/analyze-rtc-outbound-runtime.mjs';

const OUTBOUND_TOPIC = 'rallar.browser.al.outbound_runtime';
const COMPLETED_TOPIC = 'rallar.browser.messages.rtc.send_completed';

function runtimeEvent(atEpochMs, data) {
  return {
    agentId: 'controller-01',
    atEpochMs,
    value: {
      topic: OUTBOUND_TOPIC,
      payload: {
        atEpochMs,
        data: {
          runtime: 'rtc-overlay',
          ...data,
        },
      },
    },
  };
}

function completedEvent(atEpochMs, msgId, startedAtEpochMs) {
  return {
    agentId: 'controller-01',
    atEpochMs,
    value: {
      topic: COMPLETED_TOPIC,
      payload: {
        atEpochMs,
        data: {
          message: {
            message: {
              id: {
                msgId,
                ts: startedAtEpochMs,
              },
              payload: {
                typeId: 'black-box.group.multicast.position',
              },
            },
          },
        },
      },
    },
  };
}

describe('RTC outbound runtime artifact analysis', () => {
  it('rejects an artifact with no completed stream messages', () => {
    const analysis = analyzeRtcOutboundRuntimeEvents([]);

    expect(analysis.coverage.completedStreamMessages).toBe(0);
    expect(analysis.evidenceErrors).toEqual([
      'No completed stream messages are available for outbound runtime analysis.',
    ]);
  });

  it('matches original enqueue finalization and reports coverage plus drain composition', () => {
    const events = [
      runtimeEvent(120, {
        kind: 'outbound-finalization',
        message: { msgId: 'msg-1' },
        intent: 'enqueue',
        phase: 'immediate',
        resultStatus: 'enqueued',
        mode: 'awaited-new-drain',
        hadActiveDrain: false,
        durationMs: 40,
      }),
      runtimeEvent(150, {
        kind: 'outbound-finalization',
        message: { msgId: 'msg-1' },
        intent: 'dequeue',
        phase: 'dequeue',
        resultStatus: 'sent-immediate',
        mode: 'awaited-existing-drain',
        hadActiveDrain: true,
        durationMs: 10,
      }),
      runtimeEvent(180, {
        kind: 'effect-drain',
        claimedByKind: {
          'send-prepared': 3,
          'enqueue-outbox': 1,
          'fallback-dispatch': 0,
          'ack-timeout': 0,
          'repair-hint': 0,
          'nack-retry': 0,
        },
        completedByKind: {
          'send-prepared': 1,
          'enqueue-outbox': 1,
          'fallback-dispatch': 0,
          'ack-timeout': 0,
          'repair-hint': 0,
          'nack-retry': 0,
        },
        rescheduledByKind: {
          'send-prepared': 2,
          'enqueue-outbox': 0,
          'fallback-dispatch': 0,
          'ack-timeout': 0,
          'repair-hint': 0,
          'nack-retry': 0,
        },
        claimedFirstAttemptCount: 1,
        claimedRetryAttemptCount: 3,
        firstAttemptReadyLateness: {
          le0Ms: 1,
          le10Ms: 0,
          le50Ms: 0,
          le100Ms: 0,
          le250Ms: 0,
          le500Ms: 0,
          le1000Ms: 0,
          le2500Ms: 0,
          le5000Ms: 0,
          gt5000Ms: 0,
        },
        retryAttemptReadyLateness: {
          le0Ms: 0,
          le10Ms: 0,
          le50Ms: 0,
          le100Ms: 0,
          le250Ms: 3,
          le500Ms: 0,
          le1000Ms: 0,
          le2500Ms: 0,
          le5000Ms: 0,
          gt5000Ms: 0,
        },
      }),
      completedEvent(200, 'msg-1', 100),
      completedEvent(220, 'msg-missing', 100),
    ];

    const analysis = analyzeRtcOutboundRuntimeEvents(events);

    expect(analysis.coverage).toEqual({
      completedStreamMessages: 2,
      matchedEnqueueFinalizations: 1,
      missingEnqueueFinalizations: 1,
      ambiguousEnqueueFinalizations: 0,
    });
    expect(analysis.enqueueByMode['awaited-new-drain']).toMatchObject({
      count: 1,
      finalizationDurationMs: expect.objectContaining({ p95: 40 }),
      sendDurationMs: expect.objectContaining({ p95: 100 }),
    });
    expect(analysis.enqueueByMode['awaited-existing-drain'].count).toBe(0);
    expect(analysis.drainComposition).toMatchObject({
      claimedByKind: expect.objectContaining({
        'enqueue-outbox': 1,
        'send-prepared': 3,
      }),
      completedByKind: expect.objectContaining({
        'enqueue-outbox': 1,
        'send-prepared': 1,
      }),
      rescheduledByKind: expect.objectContaining({
        'send-prepared': 2,
      }),
      claimedFirstAttemptCount: 1,
      claimedRetryAttemptCount: 3,
      retryAttemptReadyLateness: expect.objectContaining({ le250Ms: 3 }),
    });
    expect(analysis.agents['controller-01']).toMatchObject({
      coverage: {
        completedStreamMessages: 2,
        matchedEnqueueFinalizations: 1,
        missingEnqueueFinalizations: 1,
        ambiguousEnqueueFinalizations: 0,
      },
      enqueueByMode: {
        'awaited-new-drain': {
          count: 1,
          finalizationDurationMs: expect.objectContaining({ p95: 40 }),
          sendDurationMs: expect.objectContaining({ p95: 100 }),
        },
      },
      drainComposition: {
        drainCount: 1,
        claimedByKind: expect.objectContaining({ 'send-prepared': 3 }),
        rescheduledByKind: expect.objectContaining({ 'send-prepared': 2 }),
      },
    });
    expect(analysis.evidenceErrors).toEqual([
      '1 completed stream messages are missing enqueue finalization diagnostics.',
    ]);
  });
});

import {
  createRtcTopologyReplayDiagnostics,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-diagnostics.ts';
import { describe, expect, it } from 'vitest';

describe('RTC topology replay diagnostics', () => {
  it('aggregates only the bounded plan dimensions and resets all counts', () => {
    const diagnostics = createRtcTopologyReplayDiagnostics();

    diagnostics.record({ kind: 'wake', source: 'notification' });
    diagnostics.record({ kind: 'wake', source: 'poll' });
    diagnostics.record({ kind: 'wake', source: 'poll' });
    diagnostics.record({
      kind: 'drain',
      outcome: 'yielded',
      durationMs: 12,
      pageCount: 10,
      entryCount: 1_000,
      maxLagEntries: 1_250,
    });
    diagnostics.record({
      kind: 'drain',
      outcome: 'failed',
      durationMs: 3,
      pageCount: 1,
      entryCount: 2,
      maxLagEntries: 2,
    });
    diagnostics.record({ kind: 'entry', outcome: 'current-repair' });
    diagnostics.record({ kind: 'entry', outcome: 'no-local-recipient' });
    diagnostics.record({ kind: 'entry', outcome: 'send-failed' });
    diagnostics.record({ kind: 'entry', outcome: 'corrupt' });
    diagnostics.record({ kind: 'cursor', outcome: 'advanced' });
    diagnostics.record({ kind: 'cursor', outcome: 'conflict' });
    diagnostics.record({ kind: 'cursor', outcome: 'gap' });
    diagnostics.record({ kind: 'hydration', outcome: 'unauthorized' });

    expect(diagnostics.readMetrics()).toEqual({
      wakeCountBySource: {
        startup: 0,
        notification: 1,
        'local-commit': 0,
        poll: 2,
      },
      drainCountByOutcome: {
        'caught-up': 0,
        yielded: 1,
        failed: 1,
        'lease-lost': 0,
      },
      entryCountByOutcome: {
        delivered: 0,
        'current-repair': 1,
        'no-local-recipient': 1,
        'send-failed': 1,
        corrupt: 1,
      },
      cursorCountByOutcome: { advanced: 1, conflict: 1, gap: 1 },
      hydrationCountByOutcome: {
        sent: 0,
        unauthorized: 1,
        'no-topology': 0,
        retry: 0,
        'stale-generation': 0,
      },
      drainAttemptCount: 2,
      drainCompletionCount: 1,
      drainFailureCount: 1,
      pageCount: 11,
      replayedEntryCount: 1_002,
      directCurrentRepairCount: 1,
      noLocalRecipientCount: 1,
      sendFailureCount: 1,
      cursorConflictCount: 1,
      gapCount: 1,
      corruptReferenceCount: 1,
      totalDrainDurationMs: 15,
      maxObservedLagEntries: 1_250,
    });

    diagnostics.resetMetrics();
    expect(diagnostics.readMetrics().drainAttemptCount).toBe(0);
    expect(diagnostics.readMetrics().wakeCountBySource.poll).toBe(0);
    expect(diagnostics.readMetrics().maxObservedLagEntries).toBe(0);
  });

  it('rejects invalid numeric observations instead of poisoning metrics', () => {
    const diagnostics = createRtcTopologyReplayDiagnostics();

    expect(() =>
      diagnostics.record({
        kind: 'drain',
        outcome: 'caught-up',
        durationMs: Number.NaN,
        pageCount: 0,
        entryCount: 0,
        maxLagEntries: 0,
      }),
    ).toThrow(/duration/);
  });
});

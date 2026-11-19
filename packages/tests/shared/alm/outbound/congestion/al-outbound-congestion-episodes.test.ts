import { describe, expect, it } from 'vitest';

import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import type { ALDeliveryAttemptOutcome, ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_CONGESTION_EPISODE_BOUNDS_MS,
    ALOutboundCongestionEpisodes
} from '@shared/alm/outbound/congestion/al-outbound-congestion-episodes.ts';

type CongestionAction = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'congestion'; }>['action'];

function congestion(msgId: string, atMs: number, carrier: ALDeliveryCarrier = 'rtc', action: CongestionAction = 'defer') {
    return {
        kind: 'congestion',
        carrier,
        cause: 'backpressured',
        action,
        priority: 1,
        msgId,
        atMs,
        traceId: `trace-${msgId}`,
        corrId: msgId
    } satisfies ALOutboundRuntimeDiagnosticsEvent;
}

function attemptSettled(
    msgId: string,
    atMs: number,
    outcome: ALDeliveryAttemptOutcome,
    carrier: ALDeliveryCarrier = 'rtc'
): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId,
        traceId: `trace-${msgId}`,
        carrier,
        lane: 'volatile',
        atMs,
        attemptId: `${msgId}-attempt`,
        outcome,
        submissionAttempted: outcome === 'sent',
        detail: undefined,
        willRetry: outcome === 'not-ready'
    };
}

function expired(msgId: string, atMs: number, carrier: ALDeliveryCarrier = 'rtc'): ALDeliverySettlement {
    return { kind: 'expired', msgId, traceId: `trace-${msgId}`, carrier, lane: 'volatile', atMs, detail: 'deadline' };
}

describe('ALOutboundCongestionEpisodes', () => {
    it('reads no episode and an empty histogram on its fixed bounds before any deferral', () => {
        const figures = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 }).readFigures();

        expect(figures).toMatchObject({ openEpisodes: 0, unrecordedSamples: 0 });
        expect(figures.durationMs).toMatchObject({ upperBounds: AL_CONGESTION_EPISODE_BOUNDS_MS, count: 0 });
    });

    // The episode D656 defines: from a message's first deferral to the settlement of the attempt that was not
    // deferred again. The repeated deferrals in between are the same episode, not three short ones.
    it('measures one episode from a message\'s first deferral to the attempt that settles otherwise', () => {
        const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 });

        episodes.recordDiagnostic(congestion('m1', 1_000));
        episodes.recordSettlement(attemptSettled('m1', 1_001, 'not-ready'));
        episodes.recordDiagnostic(congestion('m1', 1_050));
        episodes.recordSettlement(attemptSettled('m1', 1_051, 'not-ready'));
        expect(episodes.readFigures()).toMatchObject({ openEpisodes: 1, durationMs: { count: 0 } });

        episodes.recordSettlement(attemptSettled('m1', 1_120, 'sent'));

        expect(episodes.readFigures()).toMatchObject({
            openEpisodes: 0,
            unrecordedSamples: 0,
            durationMs: { count: 1, sum: 120, min: 120, max: 120 }
        });
    });

    it.each(['failed', 'cancelled', 'superseded', 'expired', 'no-targets', 'unroutable', 'refused'] as const)(
        'ends an episode when the attempt settles %s',
        (outcome) => {
            const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 });

            episodes.recordDiagnostic(congestion('m1', 500));
            episodes.recordSettlement(attemptSettled('m1', 560, outcome));

            expect(episodes.readFigures()).toMatchObject({ openEpisodes: 0, durationMs: { count: 1, sum: 60 } });
        }
    );

    it('ends an episode when the message expires without another attempt', () => {
        const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 });

        episodes.recordDiagnostic(congestion('m1', 500));
        episodes.recordSettlement(expired('m1', 30_500));

        expect(episodes.readFigures()).toMatchObject({ openEpisodes: 0, durationMs: { count: 1, sum: 30_000 } });
    });

    it('keeps the two carriers of one message apart', () => {
        const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 });

        episodes.recordDiagnostic(congestion('m1', 100, 'rtc'));
        episodes.recordDiagnostic(congestion('m1', 150, 'ws'));
        episodes.recordSettlement(attemptSettled('m1', 300, 'sent', 'ws'));

        expect(episodes.readFigures()).toMatchObject({ openEpisodes: 1, durationMs: { count: 1, sum: 150 } });
    });

    it('opens no episode for a drop or a hand-over, and none for a settlement of a message never deferred', () => {
        const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 });

        episodes.recordDiagnostic(congestion('dropped', 100, 'rtc', 'drop'));
        episodes.recordDiagnostic(congestion('handed', 100, 'rtc', 'hand-over'));
        episodes.recordDiagnostic({ kind: 'rtc-queued-bytes-high-water', queuedBytes: 9 });
        episodes.recordSettlement(attemptSettled('dropped', 200, 'sent'));
        episodes.recordSettlement(attemptSettled('never-deferred', 200, 'sent'));

        expect(episodes.readFigures()).toMatchObject({ openEpisodes: 0, unrecordedSamples: 0, durationMs: { count: 0 } });
    });

    it('leaves a deferred message that never settles counted as open', () => {
        const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 });

        episodes.recordDiagnostic(congestion('m1', 100));
        episodes.recordDiagnostic(congestion('m2', 200));
        episodes.recordSettlement(attemptSettled('m2', 260, 'sent'));

        expect(episodes.readFigures()).toMatchObject({ openEpisodes: 1, durationMs: { count: 1 } });
    });

    // Bounded memory: a session that defers without end keeps a fixed number of open episodes. The one it lets go
    // is counted, so the report never claims to have measured an episode it dropped.
    it('holds at most its bound of open episodes and counts the oldest it lets go as unrecorded', () => {
        const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 2 });

        episodes.recordDiagnostic(congestion('m1', 100));
        episodes.recordDiagnostic(congestion('m2', 200));
        episodes.recordDiagnostic(congestion('m3', 300));
        episodes.recordSettlement(attemptSettled('m1', 400, 'sent'));
        episodes.recordSettlement(attemptSettled('m3', 450, 'sent'));

        expect(episodes.readFigures()).toMatchObject({
            openEpisodes: 1,
            unrecordedSamples: 1,
            durationMs: { count: 1, sum: 150 }
        });
    });

    it('counts a settlement stamped before its deferral as unrecorded, never as a negative or clamped sample', () => {
        const episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: 8 });

        episodes.recordDiagnostic(congestion('m1', 1_000));
        episodes.recordSettlement(attemptSettled('m1', 900, 'sent'));

        expect(episodes.readFigures()).toMatchObject({ openEpisodes: 0, unrecordedSamples: 1, durationMs: { count: 0 } });
    });
});

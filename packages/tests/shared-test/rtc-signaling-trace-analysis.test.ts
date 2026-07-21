import { describe, expect, it } from 'vitest';
import {
    analyzeRtcSignalingTraceLogs,
} from '@shared-test/rallar-bb-test/rtc-signaling-trace-analysis.ts';

const PREFIX = 'RTC signaling trace: ';

describe('RTC signaling trace analysis', () => {
    it('deduplicates correlated messages and summarizes boundary latency', () => {
        const rows = [
            event('offer-complete', 'client-outbox-enqueued', 1_000, 'Offer'),
            event('offer-complete', 'client-inbox-received', 1_030, 'Offer', 1_020, 1_025),
            event('offer-complete', 'rtc-dispatched', 1_040, 'Offer', 1_020, 1_025),
            event('answer-slow', 'client-outbox-sent', 2_000, 'Answer'),
            event('answer-slow', 'client-outbox-sent', 2_000, 'Answer'),
            event('answer-slow', 'client-inbox-received', 32_010, 'Answer', 32_000, 32_005),
            event('answer-slow', 'rtc-dispatched', 32_015, 'Answer', 32_000, 32_005),
            event('offer-missing-dispatch', 'client-outbox-enqueued', 3_000, 'Offer'),
            event('offer-missing-dispatch', 'client-inbox-received', 3_040, 'Offer', 3_025, 3_030),
        ];

        const analysis = analyzeRtcSignalingTraceLogs(rows.join('\n'));

        expect(analysis.events).toBe(8);
        expect(analysis.messages).toBe(3);
        expect(analysis.completeMessages).toBe(2);
        expect(
            analysis.bySignalType.Answer.boundaries.outboxToServer.p95Ms,
        ).toBe(30_000);
        expect(
            analysis.bySignalType.Answer.boundaries.serverProcessing.maxMs,
        ).toBe(5);
        expect(analysis.missingStages['rtc-dispatched']).toBe(1);
        expect(analysis.markdown).toContain('outbox-send → server-receive');
    });

    it('ignores malformed trace rows and reports warnings', () => {
        const analysis = analyzeRtcSignalingTraceLogs([
            `${PREFIX}{not-json}`,
            `${PREFIX}${JSON.stringify({ schemaVersion: 1, stage: 'rtc-dispatched' })}`,
            'ordinary log line',
        ].join('\n'));

        expect(analysis.events).toBe(0);
        expect(analysis.warnings).toHaveLength(2);
    });

    it('uses immutable message creation time when send precedes enqueue return', () => {
        const rows = [
            event('immediate-send', 'client-outbox-sent', 910, 'Offer'),
            event('immediate-send', 'client-outbox-enqueued', 920, 'Offer'),
        ];

        const analysis = analyzeRtcSignalingTraceLogs(rows.join('\n'));

        expect(analysis.boundaries.createdToSend).toMatchObject({
            count: 1,
            p50Ms: 10,
            p95Ms: 10,
            maxMs: 10,
        });
        expect(analysis.warnings).toEqual([]);
    });
});

function event(
    messageId: string,
    stage: string,
    atEpochMs: number,
    signalType: 'Offer' | 'Answer',
    serverReceivedAtEpochMs?: number,
    serverForwardedAtEpochMs?: number,
): string {
    return `${PREFIX}${JSON.stringify({
        schemaVersion: 1,
        stage,
        messageId,
        messageCreatedAtEpochMs: 900,
        atEpochMs,
        elapsedMs: atEpochMs - 900,
        signalType,
        fromId: 'sender',
        toId: 'target',
        ...(serverReceivedAtEpochMs === undefined
            ? {}
            : { serverReceivedAtEpochMs }),
        ...(serverForwardedAtEpochMs === undefined
            ? {}
            : { serverForwardedAtEpochMs }),
    })}`;
}

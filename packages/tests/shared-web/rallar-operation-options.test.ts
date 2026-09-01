import { toRallarCommandOptions, toRallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/web-rtc-connection-service.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar operation options compatibility', () => {
    it('normalizes operation options without adding empty fields', () => {
        const signal = new AbortController().signal;
        const shouldRetry = vi.fn(() => true);
        const lanes: readonly RtcDataChannelLaneConfig[] = [{ id: 'motion', label: 'motion' }];

        expect(toRallarOperationOptions({})).toEqual({});
        expect(
            toRallarOperationOptions({
                signal,
                timeoutMs: 250,
                maxAttempts: 3,
                shouldRetry,
                dataChannelLanes: lanes,
                maxPeerConnections: 12,
                rttReportingDegreeLimit: 3
            })
        ).toEqual({
            signal,
            timeoutMs: 250,
            maxAttempts: 3,
            shouldRetry,
            dataChannelLanes: lanes,
            maxPeerConnections: 12,
            rttReportingDegreeLimit: 3
        });
        expect(
            toRallarOperationOptions({
                rttReportingDegreeLimit: 3
            })
        ).toEqual({
            rttReportingDegreeLimit: 3
        });
    });
});

it('normalizes thrown non-errors before invoking the application retry policy', () => {
    const observed: { error: Error; attempt: number; }[] = [];
    const options = toRallarCommandOptions({
        shouldRetry: (error, attempt) => {
            observed.push({ error, attempt });
            return false;
        }
    });
    expect(options.shouldRetry?.('disconnected', 2)).toBe(false);
    expect(observed).toHaveLength(1);
    expect(observed[0].error).toBeInstanceOf(Error);
    expect(observed[0].error.message).toBe('disconnected');
    expect(observed[0].attempt).toBe(2);
});

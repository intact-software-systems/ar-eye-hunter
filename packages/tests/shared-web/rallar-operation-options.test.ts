import { toRallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
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

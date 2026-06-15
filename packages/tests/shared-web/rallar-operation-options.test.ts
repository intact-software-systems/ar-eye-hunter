import { describe, expect, it, vi } from 'vitest';
import { toRallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';

describe('Rallar operation options compatibility', () => {
    it('normalizes operation options without adding empty fields', () => {
        const signal = new AbortController().signal;
        const shouldRetry = vi.fn(() => true);
        const lanes = [{ laneId: 'motion' }];

        expect(toRallarOperationOptions({})).toEqual({});
        expect(
            toRallarOperationOptions({
                signal,
                timeoutMs: 250,
                maxAttempts: 3,
                shouldRetry,
                dataChannelLanes: lanes,
                maxPeerConnections: 12,
            }),
        ).toEqual({
            signal,
            timeoutMs: 250,
            maxAttempts: 3,
            shouldRetry,
            dataChannelLanes: lanes,
            maxPeerConnections: 12,
        });
    });
});

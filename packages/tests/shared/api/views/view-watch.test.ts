import { decodeSessionPreviewWatchRequest, decodeSessionPreviewWatchResult } from '@shared/api/views/view-watch.ts';
import { expect, it } from 'vitest';

it('keeps watch mutation authority out of the client body and accepts a fenced clear', () => {
    const request = { groupId: null, connectionGenerationId: 'generation', expectedRegistrationId: 'old-request' };
    expect(decodeSessionPreviewWatchRequest(request)).toEqual(request);
    expect(() => decodeSessionPreviewWatchRequest({ ...request, principalId: 'other' })).toThrow();
    expect(() => decodeSessionPreviewWatchRequest({ ...request, expectedRegistrationId: undefined })).toThrow();
});

it('decodes an exact conflicting predecessor and rejects incomplete registrations', () => {
    const result = { status: 'conflict', requestId: 'attempt', registrationId: 'current', groupId: 'group' };
    expect(decodeSessionPreviewWatchResult(result)).toEqual(result);
    expect(() => decodeSessionPreviewWatchResult({ ...result, registrationId: null })).toThrow();
    expect(() => decodeSessionPreviewWatchResult({ ...result, status: 'accepted' })).toThrow();
});
